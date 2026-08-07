/**
 * Keyboard + end-of-match trace rig.
 *
 * A sibling of tools/shoot.mjs that exists to PROVE two things with the real
 * keyboard over CDP rather than by reading the source and hoping:
 *
 *   node tools/kbtrace.mjs --stage=trade   [--w=667] [--h=375] [--shots=1]
 *     Walks the settler to the Great Market, then drives the whole trade sheet
 *     with Input.dispatchKeyEvent: Enter opens, Left/Right move the cursor,
 *     Up/Down change the amount, Enter trades and the sheet STAYS OPEN, Escape
 *     closes — and the settler moves again straight afterwards.
 *
 *   node tools/kbtrace.mjs --stage=end --beat=early|mid|late
 *     Forces a victory and samples the win sequence every 150ms, printing when
 *     the camera pulls out, when the winner's tiles light and when the results
 *     land. Captures one beat per run because a SwiftShader capture costs
 *     several seconds of wall clock and would smear the next beat.
 *
 *   node tools/kbtrace.mjs --stage=dock
 *     The review loop: dismiss the results, toggle Close View / Board View,
 *     bring the score back with Enter.
 *
 * Every assertion prints PASS/FAIL and the process exits non-zero on any FAIL,
 * so this is runnable as a check rather than only as a screenshot source.
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
const OUT = resolve(ROOT, arg('out', 'progress/shots'));
const PORT = +arg('port', 5173);
const STAGE = arg('stage', 'trade');
const BEAT = arg('beat', 'early');
/* A SwiftShader boot costs ~8s and the whole trade script ~30s, which does not
   fit one short shell call. `--part=a|b` splits it; `all` runs the lot. */
const PART = arg('part', 'all');
const partA = PART === 'a' || PART === 'all';
const partB = PART === 'b' || PART === 'all';
const partC = PART === 'c' || PART === 'all';
const SHOTS = arg('shots', '1') === '1';
const TAG = arg('tag', '');
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fails = 0;
const T0 = Date.now();
const secs = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(4);
const ok = (cond, label, extra = '') => {
  if (!cond) fails++;
  console.log(`${secs()}s ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  return cond;
};

const DP = 9600 + Math.floor(Math.random() * 400);
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
  } catch { /* not up yet */ }
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
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, 40000);
});
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};
/* One SwiftShader capture costs six seconds, which is most of a shell call's
   budget. `--only=02` narrows a run to the one frame it is actually for. */
const ONLY = arg('only', '');
const shot = async name => {
  if (!SHOTS) return;
  if (ONLY && !name.includes(ONLY)) return;
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 84 });
  if (!r?.data) { console.log(`  shot ${name} FAILED`); return; }
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(resolve(OUT, `${name}.jpg`), buf);
  console.log(`  shot ${name}.jpg (${(buf.length / 1024).toFixed(0)} KB)`);
};

/* Real key events, not synthetic DOM dispatch: this has to go through the same
   path a phone keyboard or a laptop would, or the trace proves nothing. */
const KEYS = {
  Enter: ['Enter', 'Enter', 13],
  Escape: ['Escape', 'Escape', 27],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  Tab: ['Tab', 'Tab', 9]
};
async function tap(name, gap = 120) {
  const [key, code, kc] = KEYS[name];
  const base = { key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await sleep(40);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(gap);
}
async function clickAt(x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  await sleep(260);
}

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 50; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(250);
}
if (!booted) { console.error('GAME DID NOT BOOT'); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }
console.log(`booted ${W}x${H} stage=${STAGE}${BEAT && STAGE === 'end' ? ' beat=' + BEAT : ''}`);

/*
 * SwiftShader renders this island at barely two frames a second, and
 * `input.update()` — where a held key becomes a stick value — runs once per
 * frame. Measured against a wall clock that meant a 900ms key hold landed on
 * ONE simulation frame and the settler looked broken when it was only starving.
 *
 * Two fixes, and both matter:
 *   --fast   drop the render target to a fifth of its size. The DOM layout is
 *            untouched (still a real 667x375 viewport) but frames come ~10x
 *            quicker, so the trace measures the game rather than the rasteriser.
 *            Off automatically whenever we are capturing.
 *   frames() gate on `input.frame`, which ticks once per rAF, instead of on
 *            milliseconds. Every wait below is "let the game run N frames".
 */
/*
 * main.js runs at most four 1/60 fixed steps per animation frame, so the
 * simulation can never advance faster than the renderer. Under SwiftShader that
 * put the victory sequence at a fifth of real speed and no wall-clock wait was
 * ever going to reach the scoreboard. When we are not photographing anything,
 * hide the 3D scene outright: the DOM, the input path, the flow state machine
 * and every timing in WIN are untouched, but frames become nearly free and the
 * sequence runs at its real pace.
 */
const NOGL = arg('nogl', SHOTS ? '0' : '1') === '1';
if (NOGL) {
  await ev(`(()=>{window.__ISLAND__.scene.visible=false;return 1})()`);
  console.log('  3D scene hidden (timings only)');
}

const PR = +arg('pr', SHOTS ? 0.6 : 0.2);
if (PR > 0 && PR < 1) {
  console.log('  render scaled down: pixelRatio ' + JSON.stringify(
    await ev(`(()=>{const{renderer}=window.__ISLAND__;
      renderer.setPixelRatio(${PR}); return renderer.getPixelRatio();})()`)));
}

const frameNo = async () => +(await ev(`window.__ISLAND__.game.input.frame`)) || 0;
/** Let the game run `n` real frames (bounded, so a stall cannot hang the run). */
async function frames(n, capMs = 9000) {
  const start = await frameNo();
  const t = Date.now();
  while (Date.now() - t < capMs) {
    await sleep(45);
    if ((await frameNo()) - start >= n) return true;
  }
  return false;
}

await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m}).then(()=>1)`, true);
await ev(`import('/src/board/layout.js').then(m=>{window.__L__=m}).then(()=>1)`, true);

const finishDraft = async () => ev(`(()=>{const {state}=window.__ISLAND__,R=window.__R__;
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

/** Everything the trade sheet shows, read straight off the DOM. */
const readTrade = async () => ev(`(()=>{
  const g=window.__ISLAND__.game, s=window.__ISLAND__.state;
  // The wrapper is what carries .hid on close; the sheet inside keeps its own
  // class from the last show(), so reading the sheet alone always says "open".
  const wrap=document.querySelector('.panels');
  const sheet=document.querySelector('.sheet.trade');
  const cols=[...document.querySelectorAll('.sheet.trade .tr-col')];
  const cur=document.querySelector('.sheet.trade .tr-col.cur');
  const txt=n=>(n&&n.textContent||'').trim();
  const cards={};
  for(const c of cols){
    const r=c.getAttribute('data-res');
    const up=c.querySelector('.tr-arr.up'), dn=c.querySelector('.tr-arr.dn');
    /* The staged amounts moved OFF the arrows and onto the card, where they are
       drawn as a delta on the pile itself — "was" only appears once something
       is staged, so with a clean row "now" is simply how many you hold. The
       rate moved the other way, up into the header, and a card only carries one
       of its own when it disagrees with the header (a 2:1 dock). */
    const w=txt(c.querySelector('.tr-was')).replace(/[^0-9]/g,'');
    cards[r]={
      rate:txt(c.querySelector('.tr-rate')),
      was:w, now:txt(c.querySelector('.tr-now')),
      have:w||txt(c.querySelector('.tr-now')),
      act:txt(c.querySelector('.tr-act u')),
      up:!!up&&!up.classList.contains('off'),
      dn:!!dn&&!dn.classList.contains('off'),
      dim:c.classList.contains('dim'),
      armed:c.classList.contains('armed'),
      giving:c.classList.contains('giving'),
      getting:c.classList.contains('getting')
    };
  }
  return {
    kind:g.panels?g.panels.kind:null,
    open:!!(wrap&&!wrap.classList.contains('hid')&&sheet&&!sheet.classList.contains('hid')),
    cls:(wrap?wrap.className:'-')+' / '+(sheet?sheet.className:'-'),
    cursor:cur?cur.getAttribute('data-res'):null,
    order:cols.map(c=>c.getAttribute('data-res')),
    cards,
    give:cols.filter(c=>c.classList.contains('giving')).map(c=>c.getAttribute('data-res')),
    get:cols.filter(c=>c.classList.contains('getting')).map(c=>c.getAttribute('data-res')),
    upsLive:cols.filter(c=>!c.querySelector('.tr-arr.up').classList.contains('off'))
      .map(c=>c.getAttribute('data-res')),
    dnsLive:cols.filter(c=>!c.querySelector('.tr-arr.dn').classList.contains('off'))
      .map(c=>c.getAttribute('data-res')),
    where:txt(document.querySelector('.sheet.trade .tr-where')),
    headRate:txt(document.querySelector('.sheet.trade .tr-headrate')),
    dim:cols.filter(c=>c.classList.contains('dim')).map(c=>c.getAttribute('data-res')),
    armed:cols.filter(c=>c.classList.contains('armed')).map(c=>c.getAttribute('data-res')),
    /* The foot's prose is gone (see ui.css's .tr-cap block): the lanes are
       coloured bands now and the one live message rides in the band it is
       about. "say" is whichever band is currently saying something. */
    say:[...document.querySelectorAll('.sheet.trade .tr-cap.say')]
      .map(c=>c.className.indexOf('give')>=0 ? 'give:'+txt(c.querySelector('.tc-live'))
        : 'get:'+txt(c.querySelector('.tc-live'))).join(' | '),
    lanes:[...document.querySelectorAll('.sheet.trade .tr-cap b')].map(txt),
    tradeOff:!!document.querySelector('.sheet.trade .sheet-foot .btn.off'),
    captured:!!(g.input&&g.input.keyboardCaptured),
    res:{...s.players[0].res}, traded:s.players[0].stats.traded,
    px:+s.players[0].x.toFixed(2), pz:+s.players[0].z.toFixed(2),
    cue:!!document.querySelector('.tradecue:not(.hid)')
  };})()`);

/** The world prompt: is it up, how big is it, and what does it say. */
const readCue = async () => ev(`(()=>{
  const n=document.querySelector('.tradecue:not(.hid) .tc-card');
  if(!n) return {up:false};
  const r=n.getBoundingClientRect();
  return {up:true,w:Math.round(r.width),h:Math.round(r.height),
    text:(n.textContent||'').replace(/\\s+/g,' ').trim()};})()`);

const endState = async () => ev(`(()=>{
  const I=window.__ISLAND__, g=I.game;
  const seen=n=>{const e=document.querySelector(n);return !!(e&&!e.classList.contains('hid'));};
  return { phase:I.state.phase, kind:g.panels?g.panels.kind:null,
    over:!!(g.flow&&g.flow.isWinSequence), winner:g.flow?g.flow.winner:-1,
    wt:g.flow&&g.flow.winT!==undefined?+g.flow.winT.toFixed(2):-1,
    view:g.flow?g.flow.endView:null,
    overview:!!(g.camera&&g.camera.isOverview),
    banner:seen('.endwin'), bar:seen('.endbar'), results:seen('.results'),
    lit:document.querySelectorAll('.rs-row').length };})()`);

/* ============================================================== trade stage */

if (STAGE === 'trade') {
  await finishDraft();
  await frames(24);                       // let matchflow hand off into play

  const FILL = `['wood','brick','wool','wheat','ore']`;
  /** Stand the settler on the market's own hex, with the pack set as asked. */
  const standAtMarket = async (pack = 12) => ev(`(()=>{
    const {state}=window.__ISLAND__,M=window.__L__.MARKET;
    const p=state.players[0];
    p.x=M.x; p.z=M.z+1.2; p.vx=0; p.vz=0;
    for(const r of ${FILL}) p.res[r]=${pack};
    return [+p.x.toFixed(2),+p.z.toFixed(2)];})()`);
  const setPack = async obj => ev(`(()=>{const p=window.__ISLAND__.state.players[0];
    const o=${JSON.stringify(obj)};
    for(const r of ${FILL}) p.res[r]=(o[r]===undefined?o['*']:o[r])|0;
    return {...p.res};})()`);

  await standAtMarket(12);
  await frames(8);

  /* Baseline: the arrows drive the settler BEFORE any panel exists. Without
     this the "it moves again afterwards" check cannot tell a capture leak from
     a settler that was never going anywhere in the first place. */
  const at = async () => ev(`(()=>{const p=window.__ISLAND__.state.players[0];
    return [+p.x.toFixed(3),+p.z.toFixed(3)];})()`);
  /** Hold a direction for `n` rendered frames and report how far it went. */
  async function drive(name, n = 12) {
    const [key, code, kc] = KEYS[name];
    const base = { key, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc };
    const a = await at();
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await frames(n);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await frames(2);
    const b = await at();
    return { from: a, to: b, d: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  }

  // Only part C compares against this, and a capture run has no time to spare.
  if (partC) {
    const base0 = await drive('ArrowUp');
    ok(base0.d > 0.4, 'baseline: arrows drive the settler before any panel',
      `${base0.from} -> ${base0.to}  (${base0.d.toFixed(2)}u)`);
  }

  await standAtMarket(12);
  await frames(6);

  /* ------------------------------------------------------------- part A
     The whole fast path, keystroke by keystroke: Enter, one arrow, Up, one
     arrow, Down, Enter. */
  if (partA) {
  let t = await readTrade();
  ok(t.cue === true, 'world prompt is up while standing ON the market hex');
  ok(t.kind === null, 'nothing open before Enter');
  const cue = await readCue();
  ok(/Enter/i.test(String(cue.text)), 'the prompt names the Enter key', JSON.stringify(cue.text));
  /* The bound was 34, and it has been failing at 35 since the chip was told to
     grow: "make the press enter to trade on the ports and trading post larger
     so it's easier to see." hud-trade.js took the type from 9px to 14 and the
     plate grew with it. 44 is still less than a quarter of the banner this
     replaced, and it is the number the owner's own instruction implies. */
  ok(cue.h <= 44, 'and it is a small chip, not a banner',
    `${cue.w}x${cue.h}px "${cue.text}"`);
  await shot(`kb${TAG}-01-cue`);

  // Walking off the market hex must take the prompt away entirely.
  await ev(`(()=>{const p=window.__ISLAND__.state.players[0],M=window.__L__.MARKET;
    p.x=M.x; p.z=M.z+14; p.vx=0; p.vz=0; return 1;})()`);
  await frames(30);
  ok((await readCue()).up === false, 'off the hex, the prompt is gone');
  await standAtMarket(12);
  await frames(10);
  ok((await readCue()).up === true, 'back on the hex, it is up again');

  // ---- Enter opens
  await tap('Enter', 400);
  t = await readTrade();
  ok(t.open && t.kind === 'trade', 'Enter opened the trade sheet');
  ok(t.captured === true, 'input.js keyboard capture is ON while open');
  ok(t.order.length === 5, 'one row of five cards', t.order.join(' '));
  /* The rate is quoted ONCE, beside the name of the post. It used to be stamped
     on all five cards, which at the Great Market is the same three characters
     five times down one row; a card carries its own only where that rate
     disagrees with the header, which is the 2:1 dock in part B below. */
  ok(t.headRate === '4:1' && Object.values(t.cards).every(c => c.rate === ''),
    'the post\'s rate is quoted once in the header, not five times down the row',
    `header ${t.headRate} · card rates [${t.order.map(r => t.cards[r].rate).join(',')}]`);
  ok(t.order.every(r => +t.cards[r].have === (t.res[r] | 0)),
    'and each card says how many you hold', t.order.map(r => `${r} ${t.cards[r].have}`).join('  '));
  /* The lanes swapped ends: DOWN is the give arrow now, and until something has
     been asked for there is nothing for a lot to pay for. */
  ok(t.dnsLive.length === 0,
    'with nothing asked for EVERY give arrow is greyed out', `live: [${t.dnsLive}]`);
  ok(/^give:ask above/i.test(t.say),
    'and the give band says why, rather than leaving a dead lane unexplained',
    JSON.stringify(t.say));
  console.log(`  at ${t.where} | cursor ${t.cursor} | lanes ${t.lanes.join(' / ')}`);
  await shot(`kb${TAG}-02-panel`);

  // ---- Left / Right move between cards
  const c0 = t.cursor;
  await tap('ArrowRight');
  const t1 = await readTrade();
  ok(t1.cursor !== c0, 'ArrowRight moved to the next card', `${c0} -> ${t1.cursor}`);
  await tap('ArrowLeft');
  ok((await readTrade()).cursor === c0, 'ArrowLeft moved back', `-> ${c0}`);

  /* ---- Up ASKS. The lanes swapped ends:
   *
   *   "I think the 'you give' and 'you receive' should swap sides, with the
   *    'you receive' on the top. Since basically how many resources I have is
   *    in the middle, so if I click the up arrow, that should mean that I'm
   *    adding that many resources to my stockpile."
   *
   * So ArrowUp puts a card into YOU RECEIVE and the pile under it counts UP —
   * the delta on the card is the whole point of the arrangement, and it is what
   * gets read here rather than a badge on the arrow. */
  const held0 = +t.cards[c0].have;
  await tap('ArrowUp');
  const u1 = await readTrade();
  ok(u1.get.length === 1 && u1.get[0] === c0, 'ArrowUp staged it into YOU RECEIVE',
    `get=[${u1.get}]`);
  ok(u1.cards[c0].was === String(held0) && u1.cards[c0].now === String(held0 + 1),
    'and the pile itself counts up, in the card\'s own numeral',
    `${u1.cards[c0].was} -> ${u1.cards[c0].now}`);
  ok(u1.dnsLive.length === 5,
    'and now every give arrow is live, because there is something to pay for',
    `live: [${u1.dnsLive}]`);
  ok(u1.tradeOff === true, 'half a deal is not a deal yet', JSON.stringify(u1.say));
  ok(/^give:tap a card to pay$/i.test(u1.say),
    'and the GIVE band says what to do next, in the lane it has to be done in',
    JSON.stringify(u1.say));
  ok(u1.armed.length === 4 && !u1.armed.includes(c0),
    'twelve of everything covers a one-card ask, so every other pile arms',
    `armed: [${u1.armed}]`);

  // ---- Down on another card hands over the lot that pays for it
  await tap('ArrowRight');
  const target = (await readTrade()).cursor;
  const heldT = +u1.cards[target].have;
  await tap('ArrowDown');
  const d1 = await readTrade();
  ok(d1.give.length === 1 && d1.give[0] === target, 'ArrowDown staged YOU GIVE',
    `give=[${d1.give}]`);
  ok(d1.cards[target].was === String(heldT) && d1.cards[target].now === String(heldT - 4),
    'and that pile counts DOWN by a whole lot', `${d1.cards[target].was} -> ${d1.cards[target].now}`);
  ok(d1.cards[target].dn === false && d1.dnsLive.length === 1 && d1.dnsLive[0] === c0,
    'every give arrow greys out again — one lot pays for exactly one card '
    + '(only the staged ask stays live, to undo it)', `still live: [${d1.dnsLive}]`);
  ok(d1.tradeOff === false, 'the deal is now legal and Trade lights up');
  ok(d1.say === '', 'and with the deal balanced neither band has anything left to say',
    JSON.stringify(d1.say));
  await shot(`kb${TAG}-03-staged`);

  // ---- Enter trades, and the sheet stays open
  const before = d1;
  await tap('Enter', 520);
  const after = await readTrade();
  ok(after.traded > before.traded, 'Enter did the deal', `trades ${before.traded} -> ${after.traded}`);
  ok(after.res[target] === before.res[target] - 4, 'four of the given resource were spent',
    `${target} ${before.res[target]} -> ${after.res[target]}`);
  ok(after.res[c0] === before.res[c0] + 1, 'one of the wanted resource arrived',
    `${c0} ${before.res[c0]} -> ${after.res[c0]}`);
  ok(after.kind === 'trade' && after.open, 'the sheet STAYED OPEN after trading');
  ok(after.give.length === 0 && after.get.length === 0,
    'and the row reset, ready for the next one');

  // ---- a second deal without leaving: Up, Left, Down, Enter
  await tap('ArrowUp');            // ask on the card the cursor is already on
  const s2 = await readTrade();
  if (s2.get.length) {
    await tap('ArrowLeft');
    await tap('ArrowDown');
    const r2 = await readTrade();
    ok(r2.tradeOff === false, 'a second deal staged in three keys', JSON.stringify(r2.say));
    await tap('Enter', 520);
    ok((await readTrade()).traded > after.traded,
      'and Enter traded again without ever reopening the sheet');
  } else ok(false, 'a second ask could be staged');
  await tap('Escape', 420);
  }

  /* ------------------------------------------------------------- part B
     Grey-out is the whole brief: nothing impossible may ever be stageable. */
  if (partB) {
  // Two brick at 4:1 — brick cannot be given, and the card says so.
  await setPack({ '*': 12, brick: 2 });
  await standAtMarket(12);
  await setPack({ '*': 12, brick: 2 });
  await frames(6);
  await tap('Enter', 420);
  const g = await readTrade();
  ok(g.kind === 'trade', 'Enter opened the sheet');
  /* WHAT DIMS IS A FACT ABOUT THE PACK, not about the size of the ask: you do
     not hold one whole lot of this, so it can never pay for anything at this
     post. Two brick at 4:1 is exactly that, and twelve of anything else is
     exactly not. The dim and the give arrow under it always agree — a card
     saying no over a button saying yes was the version a reviewer threw out. */
  ok(g.cards.brick.dim === true, 'holding 2 brick at 4:1, the brick card is dimmed',
    `have ${g.cards.brick.have} at ${g.headRate}`);
  ok(g.cards.wood.dim === false, 'while wood, with twelve, is lit');
  ok(g.dim.length === 1 && g.dim[0] === 'brick',
    'and it is the only pile in the row that cannot put a lot in', `dim: [${g.dim}]`);
  /* Ask for one WOOD — not for the brick, which is where the cursor opens (the
     sheet lands on the scarcest pile, because that is what somebody walked to a
     post to buy). Asking for the brick would put the brick column on the
     receive side, and a column on the receive side keeps a live give arrow so
     the ask can be undone, which is not the thing being measured here. */
  for (let i = 0; i < 5 && (await readTrade()).cursor !== 'wood'; i++) await tap('ArrowRight');
  await tap('ArrowUp');
  const g2 = await readTrade();
  ok(g2.cards.brick.dn === false && g2.dnsLive.length === 4 && !g2.dnsLive.includes('brick'),
    'ask for one, and exactly the four piles that can afford a lot go live',
    `live: [${g2.dnsLive}]`);
  await shot(`kb${TAG}-04-disabled`);
  /* Put the row back before the next case. The ask above is still standing, and
     an ask keeps its OWN give arrow live so it can be undone — which would make
     the empty-pack check below read as one arrow that refused to grey out. */
  await tap('Tab');

  // Empty the pack outright: nothing at all can be staged.
  await setPack({ '*': 0 });
  await frames(20);                       // panels.update() re-syncs at 5Hz
  const broke = await readTrade();
  ok(broke.upsLive.length === 0 && broke.dnsLive.length === 0,
    'with an empty pack every arrow on the row is greyed out');
  ok(broke.tradeOff === true, 'and the Trade button is off', JSON.stringify(broke.say));
  await tap('Enter', 700);
  const shut = await readTrade();
  ok(shut.kind === null && !shut.open, 'Enter with nothing staged closed the sheet',
    `kind=${shut.kind} open=${shut.open} [${shut.cls}]`);

  // ---- Escape closes too
  await setPack({ '*': 12 });
  await tap('Enter', 420);
  ok((await readTrade()).kind === 'trade', 'Enter opened it again');
  await tap('Escape', 460);
  const cl2 = await readTrade();
  ok(cl2.kind === null && !cl2.open, 'Escape closed the sheet');
  ok(cl2.captured === false, 'keyboard capture was released');
  }

  /* ------------------------------------------------------------- part C */
  if (partC) {
  // ---- the settler moves again
  const m1 = await drive('ArrowUp');
  ok(m1.d > 0.4, 'the settler moves again after closing',
    `${m1.from} -> ${m1.to}  (${m1.d.toFixed(2)}u)`);
  const m2 = await drive('ArrowRight');
  ok(m2.d > 0.4, 'and it steers on ArrowRight too',
    `${m2.from} -> ${m2.to}  (${m2.d.toFixed(2)}u)`);
  // Nothing latched: the stick must be back at rest once the key is up.
  const rest = await ev(`(()=>{const s=window.__ISLAND__.game.input.stick;
    return [+s.x.toFixed(3),+s.y.toFixed(3)];})()`);
  ok(Math.abs(rest[0]) < 0.01 && Math.abs(rest[1]) < 0.01, 'no direction latched on release',
    `stick ${rest}`);

  // ---- Enter re-opens; a click outside closes
  await standAtMarket(12);
  await frames(6);
  await tap('Enter'); await frames(4);
  ok((await readTrade()).kind === 'trade', 'Enter re-opened it');
  /* A point on the scrim, computed rather than guessed. The sheet grew when the
     lanes became bands, and a fixed y=12 is now ON its top edge at 375px tall —
     which measured the tester's arithmetic, not the product. Take the widest
     free margin the scrim actually has. */
  const gap = await ev(`(()=>{const r=document.querySelector('.sheet.trade')
    .getBoundingClientRect();
    const m=[{x:Math.round(r.left+r.width/2),y:Math.round(r.top/2),s:r.top},
      {x:Math.round(r.left+r.width/2),y:Math.round((r.bottom+innerHeight)/2),
        s:innerHeight-r.bottom},
      {x:Math.round(r.left/2),y:Math.round(r.top+r.height/2),s:r.left},
      {x:Math.round((r.right+innerWidth)/2),y:Math.round(r.top+r.height/2),
        s:innerWidth-r.right}].sort((a,b)=>b.s-a.s)[0];
    return {x:m.x,y:m.y,room:Math.round(m.s),
      onScrim:(document.elementFromPoint(m.x,m.y)||{className:''}).className==='scrim'};})()`);
  await clickAt(gap.x, gap.y);
  ok((await readTrade()).kind === null, 'a click on the scrim outside the sheet closed it',
    `at ${gap.x},${gap.y} — ${gap.room}px of scrim, elementFromPoint says scrim=${gap.onScrim}`);

  // ---- the X button
  await tap('Enter', 400);
  ok((await readTrade()).kind === 'trade', 'Enter opened it once more');
  const xr = await ev(`(()=>{const b=document.querySelector('.sheet.trade .sheet-head .x');
    if(!b) return null; const r=b.getBoundingClientRect();
    return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];})()`);
  if (Array.isArray(xr)) {
    await clickAt(xr[0], xr[1]);
    ok((await readTrade()).kind === null, 'the X closed it', `at ${xr}`);
  } else ok(false, 'the X button exists');

  // ---- an arrow tap does the same job as the key
  await tap('Enter', 400);
  const upBtn = await ev(`(()=>{const c=document.querySelector('.sheet.trade .tr-col');
    const b=c&&c.querySelector('.tr-arr.up'); if(!b) return null;
    const r=b.getBoundingClientRect();
    return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2),Math.round(r.height)];})()`);
  if (Array.isArray(upBtn)) {
    await clickAt(upBtn[0], upBtn[1]);
    const tapd = await readTrade();
    ok(tapd.get.length === 1, 'tapping the top arrow asks for one, for a thumb too',
      `get=[${tapd.get}]`);
  } else ok(false, 'the receive arrows are tappable');
  await tap('Escape', 400);
  }

  if (partB) {
  /* ---- and the same routine at one of the player's own docks -------------
     The brief names the Great Market AND unlocked docks. The rate is the whole
     point of walking to a dock, so the prompt and the row both have to quote
     the dock's rate rather than the market's 4:1. The settler must be standing
     on the coastal hex the dock was built on, so we place them just inside the
     edge the dock hangs off. */
  const dock = await ev(`(()=>{const {state}=window.__ISLAND__,L=window.__L__;
    const P=L.ports,p=state.players[0];
    let id=P.findIndex(x=>x&&x.resource); if(id<0) id=0;
    p.ports.add(id);
    const e=L.edges[P[id].edge], t=L.tiles[e.tiles[0]];
    p.x=e.x+(t.x-e.x)*0.18; p.z=e.z+(t.z-e.z)*0.18; p.vx=0; p.vz=0;
    for(const r of ['wood','brick','wool','wheat','ore']) p.res[r]=12;
    return {id,resource:P[id].resource,ratio:P[id].ratio,
      d:+Math.hypot(p.x-P[id].x,p.z-P[id].z).toFixed(2)};})()`);
  await frames(10);
  const dcue = await readCue();
  ok(dcue.up === true && /Enter/i.test(String(dcue.text)),
    'the dock flies its own small ENTER prompt', JSON.stringify(dcue.text));
  ok(String(dcue.text).includes(`${dock.ratio}:1`),
    'and it quotes the DOCK rate, not the market 4:1',
    `dock ${dock.ratio}:1 (${dock.resource || 'any'}) ${dock.d}u away`);
  await shot(`kb${TAG}-05-dock`);
  await tap('Enter'); await frames(4);
  const dt = await readTrade();
  ok(dt.kind === 'trade', 'Enter opens the sheet at the dock too');
  /* The rate is quoted once in the header and a card only carries its own when
     it DISAGREES with that. At a specialised dock that is exactly the one card
     the player crossed the island for; at a generic dock every card charges the
     dock's rate, the header says so, and no card needs a badge at all. Both are
     the right answer, so both count — what must never happen is the dock's rate
     going unsaid. */
  const key = dock.resource || 'wood';
  ok(dt.cards[key].rate === `${dock.ratio}:1` || dt.headRate === `${dock.ratio}:1`,
    'the sheet quotes the DOCK\'s rate for that resource, not the market 4:1',
    `${key} card "${dt.cards[key].rate}" · header "${dt.headRate}" — "${dt.where}"`);
  ok(dock.resource ? dt.cards[key].rate === `${dock.ratio}:1` : dt.cards[key].rate === '',
    'and it is on the card only where it differs from the header',
    `${dock.resource || 'generic'} dock · card rates [`
    + `${dt.order.map(r => dt.cards[r].rate || '-').join(',')}]`);
  await shot(`kb${TAG}-06-dockpanel`);
  await tap('Escape'); await frames(3);
  ok((await readTrade()).kind === null, 'Escape closes it at the dock as well');
  }
}

/* ================================================================ end stage */

if (STAGE === 'end' || STAGE === 'dock') {
  await finishDraft();
  await frames(20);
  /* Hand the human a genuinely finished board: every legal settlement they can
     reach, upgraded to cities so the winner's network is worth lighting up, and
     then victory cards to carry them over the line. Placement alone tops out
     around four points on a fresh draft, which never triggers the sequence. */
  const forced = await ev(`(()=>{const {state}=window.__ISLAND__,R=window.__R__;
    const p=state.players[0];
    for(let i=0;i<8;i++){const L=R.legalSettlements(state,0,true);
      if(L.length)R.placeSettlement(state,0,L[Math.floor(L.length/2)]||L[0],true);}
    [...p.settlements].forEach(i=>R.upgradeCity(state,0,i,true));
    let guard=0;
    while(R.scoreOf(state,p)<13 && guard++<30) p.vpCards++;
    R.checkVictory(state);
    return {phase:state.phase,winner:state.winner,
      vp:state.players.map(q=>R.scoreOf(state,q)),
      s:p.settlements.size,c:p.cities.size,vpc:p.vpCards};})()`);

  console.log('  forced win: ' + JSON.stringify(forced));
  const t0 = Date.now();
  const marks = [];
  const samples = [];
  let confetti = null;
  const el = () => ((Date.now() - t0) / 1000).toFixed(2);

  if (STAGE === 'end') {
    /* The beat to photograph, in SEQUENCE seconds (see WIN in matchflow.js):
       the close celebration, the pulled-back board, and the scoreboard. */
    const want = BEAT === 'early' ? 1.4 : BEAT === 'mid' ? 4.2 : 6.3;
    /*
     * Rendering the island costs the same under SwiftShader whatever the pixel
     * ratio — it is vertex submission, not fill — and main.js will not advance
     * the simulation faster than it renders, so the sequence crawls at a fifth
     * of speed and no beat past three seconds is reachable inside one short
     * shell call. So: fast-forward with the scene hidden, and put it back a
     * beat before the shutter. The game clock, the flow state machine and every
     * timing in WIN run exactly as they always do; only the frames nobody is
     * photographing are skipped.
     */
    /* The opening beat is the one exception: the win plate and its confetti are
       CSS, on a wall clock, so there is nothing to fast-forward past — we want
       the shutter a beat and a half into the shower, while it is thickest. */
    const ffwd = SHOTS && BEAT !== 'early';
    if (ffwd) await ev(`(()=>{window.__ISLAND__.scene.visible=false;return 1})()`);
    let revealed = !ffwd;
    let bannerAt = 0;
    let shotDone = false;
    let last = '';
    while (Date.now() - t0 < 34000) {
      const s = await endState();
      samples.push(s);
      const sig = `${s.overview}|${s.banner}|${s.bar}|${s.results}|${s.kind}`;
      if (sig !== last) {
        last = sig;
        marks.push(`seq ${String(s.wt).padStart(5)}s (wall +${el()}s)  phase=${s.phase}`
          + ` win=${s.over} view=${s.view} overview=${s.overview}`
          + ` banner=${s.banner} results=${s.results} bar=${s.bar} kind=${s.kind}`);
      }
      if (!bannerAt && s.banner) bannerAt = Date.now();
      if (BEAT === 'early' && s.banner) {
        /* A SwiftShader capture takes seconds to come back and the paper's
           keyframes run on a main thread starved to about a frame a second, so
           the shower is proved by measuring it across the whole celebration and
           keeping the fullest sample — not by hoping it survives one shutter. */
        const c = await ev(`(()=>{const ps=[...document.querySelectorAll('.ew-paper i')];
          const H=window.innerHeight;
          const flying=ps.filter(n=>{const r=n.getBoundingClientRect();
            return r.top>-40 && r.top<H && +getComputedStyle(n).opacity>0.05;});
          return {total:ps.length,flying:flying.length,
            kinds:[...new Set(ps.map(n=>n.className))].sort(),
            shapes:[...new Set(flying.map(n=>getComputedStyle(n).width))].length};})()`);
        if (c && (!confetti || c.flying > confetti.flying)) confetti = c;
        if (!shotDone && confetti && confetti.flying >= 6) {
          shotDone = true;
          await shot(`end${TAG}-${BEAT}`);
        }
      }
      if (!revealed && s.wt >= want - 0.8) {
        revealed = true;
        await ev(`(()=>{window.__ISLAND__.scene.visible=true;return 1})()`);
      }
      if (!shotDone && s.wt >= want && revealed) {
        shotDone = true;
        await shot(`end${TAG}-${BEAT}`);
      }
      if (shotDone && SHOTS && BEAT !== 'late') break;
      if (s.results && (shotDone || !SHOTS)) break;
      await sleep(140);
    }
    console.log('  --- win sequence timeline (sequence seconds) ---');
    for (const m of marks) console.log('  ' + m);

    /* Assert on the recorded beats rather than on whatever the last poll saw:
       the banner is meant to have faded by the time the score lands, so a
       snapshot at the end can only ever prove the last beat. */
    const at = pred => samples.find(pred);
    const firstBanner = at(x => x.banner);
    const firstOver = at(x => x.overview);
    const firstRes = at(x => x.results);
    ok(!!firstBanner && firstBanner.wt < 1.0,
      'the celebration starts at once, over the live board',
      firstBanner ? `banner at seq ${firstBanner.wt}s` : 'never');
    ok(!!firstBanner && !firstBanner.overview && !firstBanner.results,
      'and it plays in the close third-person view, with no popup');
    if (BEAT === 'early') {
      ok(!!confetti && confetti.flying >= 8, 'paper is actually falling over the board',
        JSON.stringify(confetti));
      ok(!!confetti && confetti.kinds.length === 3, 'three kinds of paper, not one sprite',
        confetti ? confetti.kinds.join(' ') : '');
    }
    if (BEAT === 'mid' || BEAT === 'late') {
      ok(!!firstOver && firstOver.wt >= 2.0 && !firstOver.results,
        'the camera pulls out to the whole board BEFORE any score',
        firstOver ? `board framing at seq ${firstOver.wt}s` : 'never');
    }
    if (BEAT === 'late') {
      ok(!!firstRes && firstRes.wt >= 5.0,
        'the scoreboard is held back for several seconds of looking',
        firstRes ? `results at seq ${firstRes.wt}s` : 'never');
      ok(!!firstRes && firstRes.lit >= 4, 'every player is scored',
        firstRes ? `${firstRes.lit} rows` : '');
    }
  }

  if (STAGE === 'dock') {
    // Wait out the whole sequence, then prove the review loop. Same trick as
    // the `end` stage: skip rendering the frames nobody is photographing, so a
    // six-second sequence does not cost thirty seconds of shell budget.
    if (SHOTS) await ev(`(()=>{window.__ISLAND__.scene.visible=false;return 1})()`);
    for (let i = 0; i < 120; i++) {
      if ((await endState()).results) break;
      await sleep(200);
    }
    if (SHOTS) {
      await ev(`(()=>{window.__ISLAND__.scene.visible=true;return 1})()`);
      await sleep(500);
    }
    let s = await endState();
    ok(s.results === true, `results panel is up at t+${el()}s`);
    await shot(`end${TAG}-results`);

    // Dismiss with Escape -> the board comes back and the review bar appears.
    await tap('Escape', 600);
    s = await endState();
    ok(s.results === false, 'Escape dismissed the results');
    ok(s.bar === true, 'the match-over review bar appeared');
    await shot(`end${TAG}-review-board`);

    // Close View: back into the third-person world view.
    const btn = async label => ev(`(()=>{const b=[...document.querySelectorAll('.endbar button')]
      .find(x=>/${label}/i.test(x.textContent||''));
      if(!b) return null; const r=b.getBoundingClientRect();
      return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];})()`);
    const cv = await btn('Close View');
    if (Array.isArray(cv)) {
      await clickAt(cv[0], cv[1]);
      await sleep(1400);
      s = await endState();
      ok(s.view === 'close' && s.overview === false, 'CLOSE VIEW returns to the world view',
        `view=${s.view}`);
      await shot(`end${TAG}-review-close`);
    } else ok(false, 'the Close View button exists');

    const bv = await btn('Board View');
    if (Array.isArray(bv)) {
      await clickAt(bv[0], bv[1]);
      await sleep(1400);
      s = await endState();
      ok(s.view === 'board' && s.overview === true, 'BOARD VIEW goes back to the whole island');
    } else ok(false, 'the Board View button exists');

    // Nothing forces the player out: the score only returns when asked for.
    await sleep(2500);
    s = await endState();
    ok(s.results === false, 'the results do NOT come back on their own');
    await tap('Enter', 700);
    s = await endState();
    ok(s.results === true, 'Enter brings the score back');
    await tap('Escape', 600);
    const rb = await ev(`(()=>{const b=[...document.querySelectorAll('.endbar button')]
      .find(x=>/Results/i.test(x.textContent||''));
      if(!b) return null; const r=b.getBoundingClientRect();
      return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];})()`);
    if (Array.isArray(rb)) {
      await clickAt(rb[0], rb[1]);
      await sleep(500);
      ok((await endState()).results === true, 'so does the RESULTS button');
    } else ok(false, 'the Results button exists');
  }
}

for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 180));
console.log(`${fails} failure(s), ${exceptions.length} exception(s)`);
ws.close(); chrome.kill('SIGKILL');
process.exit(fails === 0 && exceptions.length === 0 ? 0 : 1);
