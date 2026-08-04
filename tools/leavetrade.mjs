/**
 * Island Settlers — can the player who stayed still use the trading post?
 *
 *   node tools/leavetrade.mjs [--port=8801] [--chrome=/path/to/headless_shell]
 *
 *   "When one player left... it also wouldn't let the remaining player use the
 *    trading post any more. It would open, but the trades didn't work."
 *
 * WHY THIS EXISTS WHEN nettest ALREADY COVERS IT.
 *
 * It does not. `nettest` speaks the protocol directly: its two clients are
 * sockets, and its check for this walks a settler onto the market and trades
 * through `REQ.MATCH_ACT`. That passes — the server takes the trade before the
 * peer leaves and after it, which proves the SERVER is not refusing.
 *
 * Which leaves the browser, and the browser is a different program. Between a
 * thumb and `MATCH_ACT` there is `economy.trade()`, which runs its own gates
 * first: is the match in play, is there a post within reach, is the ratio
 * affordable OUT OF THE MIRRORED PACK. All three read state that arrives over
 * the wire, and any one of them saying no produces exactly the reported
 * symptom — a sheet that opens and a trade that does not happen. A test that
 * cannot see those gates cannot clear them.
 *
 * So: ONE REAL BROWSER, playing the seat that stays, and a protocol stand-in
 * for the friend who leaves. The browser does everything a browser does — it
 * reloads into the match, mirrors snapshots, runs its own controller — and the
 * trade is driven through `game.economy.trade()`, the same call the Trade
 * button makes. The stand-in exists only to be a second human who can walk
 * out, and it is the one that CREATES the room, because the room's creator
 * leaving is the harder half (the host is handed to somebody else on the way).
 *
 * Reported alongside it, because the same departure is supposed to cause them:
 * the popup the remaining player never saw, and the standings crossing out the
 * bots who were still playing.
 *
 * Owner: net agent.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { legalSettlements, legalRoads } from '../src/core/rules.js';
import { reshuffle } from '../src/board/layout.js';
import { createMatch } from '../src/core/rules.js';
import { createMirror } from '../src/net/mirror.js';
import { REQ, PUSH, ACT, PROTOCOL_VERSION } from '../src/net/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const PORT = Number(arg('port', 8801));
const DP = 9700 + Math.floor(Math.random() * 400);
const W = Number(arg('w', 960));
const H = Number(arg('h', 444));
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/usr/lib/x86_64-linux-gnu');
const TAG = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
const DEV_S = `leavetrade-friend-${TAG}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`FAIL  ${name}  ${detail}`); }
  return ok;
}
const note = (k, v) => console.log(`  ${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

/* ============================================================ the server
   STATIC=1 so the page and its websocket share an origin — `net/config.js`
   falls back to the page's own host, which is what makes a local run need no
   configuration at all. */

let serverLog = '';
const server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT), STATIC: '1', MAX_MATCHES: '4' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', d => { serverLog += d; if(/TRADEDBG/.test(String(d))) process.stdout.write('  [srv] ' + d); });
server.stderr.on('data', d => { serverLog += d; process.stdout.write('  [srv!] ' + d); });

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${HTTP}/health`); if (r.ok) return await r.json(); }
    catch (e) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server never came up\n' + serverLog);
}

/* ============================================================ the stand-in
   A socket with just enough manners to be a person: it answers its own draft
   turns so the opening finishes at a human pace, and it can walk out. */

function connect(label) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS);
    let nextId = 1;
    const waiting = new Map();
    const pushes = [];
    const watchers = [];
    const api = {
      label, ws, onPush: null,
      req(t, body = {}) {
        const i = nextId++;
        return new Promise((ok, no) => {
          const timer = setTimeout(() => { waiting.delete(i); no(new Error(`${label}: ${t} timed out`)); }, 15000);
          waiting.set(i, { ok, no, timer });
          ws.send(JSON.stringify({ i, t, ...body }));
        });
      },
      fire(t, body = {}) { ws.send(JSON.stringify({ t, ...body })); },
      next(type, ms = 15000, pred = null) {
        const hit = m => m.t === type && (!pred || pred(m));
        const at = pushes.findIndex(hit);
        if (at >= 0) return Promise.resolve(pushes.splice(at, 1)[0]);
        return new Promise((ok, no) => {
          const w = { type, pred, no };
          const timer = setTimeout(() => {
            const j = watchers.indexOf(w); if (j >= 0) watchers.splice(j, 1);
            no(new Error(`${label}: no ${type} within ${ms}ms`));
          }, ms);
          w.ok = v => { clearTimeout(timer); ok(v); };
          watchers.push(w);
        });
      },
      close() { try { ws.close(); } catch (e) { /* going anyway */ } }
    };
    ws.addEventListener('open', () => res(api), { once: true });
    ws.addEventListener('error', e => rej(new Error(`${label}: socket error`)), { once: true });
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.i !== undefined && waiting.has(m.i)) {
        const w = waiting.get(m.i); waiting.delete(m.i); clearTimeout(w.timer);
        if (m.t === 'err') { const err = new Error(m.code || 'refused'); err.code = m.code; w.no(err); }
        else w.ok(m);
        return;
      }
      const j = watchers.findIndex(x => m.t === x.type && (!x.pred || x.pred(m)));
      if (j >= 0) { const w = watchers.splice(j, 1)[0]; w.ok(m); }
      else pushes.push(m);
      if (api.onPush) { try { api.onPush(m); } catch (err) { /* a listener cannot stop the wire */ } }
    });
  });
}

/* ============================================================== the browser */

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

function bye(code) {
  try { chrome.kill('SIGKILL'); } catch (e) { /* gone */ }
  try { server.kill('SIGTERM'); } catch (e) { /* gone */ }
  setTimeout(() => process.exit(code), 250);
}

await waitForServer();

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DP}/json/list`);
    const p = (await r.json()).find(t => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch (e) { /* not up */ }
  await sleep(180);
}
if (!wsUrl) { console.error('devtools never came up\n' + chromeErr.slice(-500)); bye(2); }

const cdp = new WebSocket(wsUrl);
await new Promise(r => cdp.addEventListener('open', r, { once: true }));
let msgId = 0;
const pending = new Map();
const exceptions = [];
cdp.addEventListener('message', e => {
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
const cdpSend = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  cdp.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, 40000);
});
const ev = async (expr, awaitPromise = false) => {
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};

await cdpSend('Page.enable');
await cdpSend('Runtime.enable');

/* ================================================================ the run */

const S = await connect('friend');
await S.req(REQ.HELLO, { version: PROTOCOL_VERSION, device: DEV_S, name: 'Friend' });
const made = await S.req(REQ.ROOM_CREATE, {});
const CODE = made.room.code;
/* Auto-draft on, from the host's chair — the setting this round moved off the
   device and into the room. It is also what lets this rig skip driving an
   opening through the browser's board panel. */
await S.req(REQ.ROOM_SETTINGS, { difficulty: 'easy', knights: true, autoDraft: true });
note('room', `${CODE} (host is the friend who will leave)`);

await cdpSend('Page.navigate', { url: `${HTTP}/index.html` });
for (let i = 0; i < 200; i++) {
  const up = await ev(`!!(window.__ISLAND__ && window.__ISLAND__.game)`);
  if (up === true) break;
  await sleep(300);
}

const joined = await ev(`(async()=>{
  const c=(await import('/src/net/client.js')).netClient();
  const P=await import('/src/net/protocol.js');
  await c.setName('Rig');
  c.connect(true);
  for(let i=0;i<60 && c.status!=='ready';i++) await new Promise(r=>setTimeout(r,150));
  if(c.status!=='ready') return {status:c.status};
  const r=await c.req(P.REQ.ROOM_JOIN,{code:'${CODE}'});
  await c.req(P.REQ.ROOM_READY,{ready:true});
  return {status:c.status, code:r&&r.room&&r.room.code, seats:r&&r.room?r.room.seats.filter(s=>s.kind==='human').length:0};
})()`, true);
note('joined', joined);
check('1. the browser can join the room the friend made',
  joined && joined.code === CODE, JSON.stringify(joined));

await S.req(REQ.ROOM_READY, { ready: true });
const beginS = await S.next(PUSH.MATCH_BEGIN, 15000);
note('match', `seed ${beginS.seed >>> 0}, friend is seat ${beginS.yourPid}`);

/* The stand-in needs a board of its own to know what is legal on its turns. */
reshuffle(beginS.seed >>> 0);
const stateS = createMatch({ seed: beginS.seed >>> 0 });
const mirrorS = createMirror(stateS, {
  yourPid: beginS.yourPid, roster: beginS.seats, order: beginS.order
});
const placedAt = new Map();
S.onPush = async msg => {
  if (msg.t === PUSH.MATCH_SNAP) { mirrorS.applySnapshot(msg); return; }
  if (msg.t === PUSH.MATCH_EV) { mirrorS.applyEvents(msg.evs); return; }
  if (msg.t !== PUSH.MATCH_DRAFT) return;
  if (msg.need === 'done' || msg.pid !== beginS.yourPid) return;
  if (msg.resend && placedAt.get('s') === msg.index) return;
  placedAt.set('s', msg.index);
  const local = mirrorS.toLocal(msg.pid);
  const legal = msg.need === 'road'
    ? legalRoads(stateS, local, true, msg.anchor)
    : legalSettlements(stateS, local, true);
  if (!legal.length) return;
  await sleep(120);
  try {
    await S.req(REQ.MATCH_ACT, {
      kind: msg.need === 'road' ? ACT.DRAFT_ROAD : ACT.DRAFT_SETTLEMENT, id: legal[0]
    });
  } catch (e) { /* the server will auto-place if this fails */ }
};

/* The browser parks the seed and reloads — that is how an island gets re-dealt
   under a scene that was built from a different one. Wait for it to come back
   up INSIDE the match rather than on the opening screen. */
let inMatch = null;
for (let i = 0; i < 150; i++) {
  await sleep(400);
  inMatch = await ev(`(()=>{const I=window.__ISLAND__;
    if(!I||!I.state)return null; const n=I.game.net;
    return {net:!!(n&&n.active), phase:I.state.phase, yourPid:(n&&n.info)?n.info.yourPid:null};})()`);
  if (inMatch && inMatch.net) break;
}
check('2. the browser reloads into the match and takes its seat',
  !!(inMatch && inMatch.net), JSON.stringify(inMatch));

/* Wait out the opening. Both seats auto-draft; three of the four are bots. */
let played = null;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  played = await ev(`(()=>{const I=window.__ISLAND__;
    return {phase:I.state.phase, b:I.state.buildings.size, r:I.state.roadOwner.size};})()`);
  if (played && played.phase === 'play' && played.b >= 8) break;
}
/* Seven is allowed, and it is the STAND-IN's fault when it happens: it picks
   from a board it deals itself, and if its second turn lands while it is still
   applying the pick before it, the server's pick clock runs out and places for
   somebody. The match is playable either way, which is all this rig needs — it
   is here to trade, not to audit the opening. `nettest` owns that claim. */
check('3. the opening finishes with nobody touching the board',
  !!(played && played.phase === 'play' && played.b >= 7),
  JSON.stringify(played));

/*
 * GATHER, THEN STAND ON THE MARKET.
 *
 * `game.input.stick` is what the invisible joystick writes and what netmatch
 * samples every frame, so pushing it here is the same journey a thumb makes.
 * A settler with an empty pack cannot test trading, so this wanders until
 * something in the pack is worth four and only then heads for the middle.
 */
/*
 * The stick cannot be written from outside. `input.update()` recomputes it
 * from the keyboard every frame unless a touch owns it, so assigning
 * `game.input.stick.x` is overwritten before netmatch ever reads it — which is
 * correct of the input module and fatal to a rig that tries to cheat. So this
 * presses and HOLDS a real drag, and steers by moving the pointer while it is
 * down. `--stage=results` in uishot does the same thing for the same reason.
 */
/* Count what actually leaves the page while the stick is held. The server is
   the only thing that can move a settler in a networked match, so if the
   position drifts here and not there, the question is whether the input ever
   went up the wire at all. */
await ev(`(async()=>{
  const c=(await import('/src/net/client.js')).netClient();
  window.__FIRE__={n:0, last:null, kinds:{}};
  const real=c.fire.bind(c);
  c.fire=(t,body)=>{ const F=window.__FIRE__; F.n++; F.kinds[t]=(F.kinds[t]||0)+1; F.last=body; return real(t,body); };
  return typeof c.fire;})()`, true);

const V = await ev('({w:innerWidth,h:innerHeight})');
const ORIGIN = { x: Math.round(V.w * 0.28), y: Math.round(V.h * 0.5) };
const REACH = 46;                       // just inside MAX_R (52) so the origin never follows

const press = () => cdpSend('Input.dispatchMouseEvent',
  { type: 'mousePressed', x: ORIGIN.x, y: ORIGIN.y, button: 'left', clickCount: 1, buttons: 1 });
const release = () => cdpSend('Input.dispatchMouseEvent',
  { type: 'mouseReleased', x: ORIGIN.x, y: ORIGIN.y, button: 'left', clickCount: 1, buttons: 0 });
const moveTo = (x, y) => cdpSend('Input.dispatchMouseEvent',
  { type: 'mouseMoved', buttons: 1, x: Math.round(x), y: Math.round(y) });

/* Where to shove the thumb to run toward a point on the island. The stick is
   in SCREEN space and netmatch turns it by the camera, so this undoes that
   rotation — the same two lines as `sendInput`, read backwards. */
const aimAt = (tx, tz) => ev(`(()=>{const I=window.__ISLAND__,g=I.game,p=I.state.players[0];
  const dx=(${tx})-p.x, dz=(${tz})-p.z, d=Math.hypot(dx,dz)||1;
  const yaw=(g.camera&&Number.isFinite(g.camera.yaw))?g.camera.yaw:0;
  const fx=-Math.sin(yaw), fz=-Math.cos(yaw), rx=-fz, rz=fx;
  const ux=dx/d, uz=dz/d;
  const RES=['wood','brick','wool','wheat','ore'];
  return {d:+d.toFixed(2), sx:+(rx*ux+rz*uz).toFixed(3), sy:+(fx*ux+fz*uz).toFixed(3),
    rich:RES.some(r=>(p.res[r]|0)>=4)};})()`);

/** Run at a point until it is close enough, or the clock runs out. */
async function runTo(tx, tz, within, secs, stopWhenRich = false) {
  const until = Date.now() + secs * 1000;
  await press();
  let last = null;
  while (Date.now() < until) {
    const a = await aimAt(tx, tz);
    if (!a || a.__err) break;
    last = a;
    if (a.d <= within || (stopWhenRich && a.rich)) break;
    await moveTo(ORIGIN.x + a.sx * REACH, ORIGIN.y - a.sy * REACH);
    await sleep(420);   // each poll is an evaluate on a main thread that is already 500ms/frame
  }
  await release();
  await sleep(500);
  return last;
}

/* A settler with an empty pack cannot test trading. Run at the far side of the
   island first — the field is thickest away from the middle — and stop the
   moment something in the pack is worth four. */
const wandered = await runTo(22, -22, 3, 45, true)
  || await runTo(-22, 22, 3, 30, true);
const parkedAt = await runTo(0, 0, 4, 75) && await runTo(0, 0, 4, 30);
await sleep(900);

const stand = await ev(`(()=>{const I=window.__ISLAND__,p=I.state.players[0];
  const RES=['wood','brick','wool','wheat','ore'];
  return {at:[+p.x.toFixed(1),+p.z.toFixed(1)], nearTrade:p.nearTrade,
    pack:RES.map(r=>p.res[r]|0)};})()`);
note('standing', stand);
note('fired', await ev('window.__FIRE__'));

/*
 * THE MEASUREMENT THE WHOLE BUG LIVES IN.
 *
 * Every positional rule — trading at a post above all — is judged on the
 * SERVER's copy of where you are, and the browser draws its own, predicted
 * one. While the two agree, nothing about that is visible. When they come
 * apart, the sheet opens on the browser's number and the trade is refused
 * against the server's, and the player is told they cannot do that here while
 * standing on it. So the gap is checked directly, before the trade is, because
 * a trade that fails for this reason and a trade that fails for any other
 * reason look identical from the outside.
 */
const gap = await ev('window.__ISLAND__.game.net.serverGap');
check('4b. the browser and the server agree about where the settler is standing',
  typeof gap === 'number' && gap >= 0 && gap < 2,
  `${typeof gap === 'number' ? gap.toFixed(2) : gap} world units apart`);
check('4. the browser can walk itself onto the Great Market with goods in hand',
  !!(stand && stand.nearTrade !== null && stand.pack.some(n => n >= 4)),
  `wander ${JSON.stringify(wandered)} park ${JSON.stringify(parkedAt)} `
  + JSON.stringify(stand));

/*
 * THE TRADE, THROUGH THE PATH THE BUTTON USES.
 *
 * `economy.trade()` is where the browser's own gates live, and it returns the
 * refusal text the sheet would have shown. The pack is read again afterwards
 * from the mirror, because the browser saying "traded" and the island actually
 * changing hands are two different claims and the bug report is about the
 * second one.
 */
const TRADE = `(async()=>{
  const I=window.__ISLAND__, g=I.game, p=I.state.players[0];
  const RES=['wood','brick','wool','wheat','ore'];
  const give=RES.find(r=>(p.res[r]|0)>=4);
  if(!give) return {how:'no-goods', pack:RES.map(r=>p.res[r]|0)};
  const get=RES.find(r=>r!==give);
  const before=RES.map(r=>p.res[r]|0);
  const sheetOpened = (()=>{ try {
    if(g.panels && typeof g.panels.openTrade==='function'){ g.panels.openTrade(); return true; }
  } catch(e){} return null; })();
  /* The browser says "Traded" the moment it hands the act to the wire — the
     server's answer comes back later and lands as a toast. Catch it, or a
     refused trade reads here exactly like a successful one. */
  const said=[];
  const realToast=g.toast;
  g.toast=(m,k)=>{ said.push(String(m)); if(realToast) try{realToast.call(g,m,k)}catch(e){} };
  const out = g.economy.trade(give, get);
  await new Promise(r=>setTimeout(r,2000));
  g.toast=realToast;
  const after=RES.map(r=>I.state.players[0].res[r]|0);
  return {how: out.ok?'traded':'refused', reason: out.reason||'', give, get,
    before, after, moved: before[RES.indexOf(give)] - after[RES.indexOf(give)],
    said, sheetOpened};
})()`;

const tradeBefore = await ev(TRADE, true);
note('trade before', tradeBefore);
check('5. a trade lands while both people are in the match',
  !!(tradeBefore && tradeBefore.how === 'traded' && tradeBefore.moved > 0),
  `${tradeBefore && tradeBefore.how} ${tradeBefore && tradeBefore.reason} `
  + `(gave ${tradeBefore && tradeBefore.moved})`);

/* ------------------------------------------------------------ and now leave */

await S.req(REQ.MATCH_LEAVE, {});
S.close();
await sleep(2500);

const afterLeave = await ev(`(()=>{const I=window.__ISLAND__;
  const rows=[...document.querySelectorAll('.ranks .rk')].map(r=>({
    txt:(r.textContent||'').trim().slice(0,18), cls:r.className,
    struck:r.classList.contains('left'), away:r.classList.contains('away')}));
  const ann=document.querySelector('.announce');
  return {rows, struck:rows.filter(r=>r.struck).length,
    announce: ann?(ann.textContent||'').trim():null,
    annUp: !!(ann&&!ann.classList.contains('hid')&&ann.textContent),
    states:I.state.players.map(p=>p.netState),
    phase:I.state.phase};})()`);
note('after leave', afterLeave);
check('6. exactly one name is crossed out — the person, not the bots',
  !!(afterLeave && afterLeave.struck === 1),
  `${afterLeave && afterLeave.struck} struck of ${afterLeave && afterLeave.rows.length}, `
  + `states ${afterLeave && afterLeave.states.join(',')}`);
check('7. the remaining player is told their friend left',
  !!(afterLeave && afterLeave.annUp && /left/i.test(afterLeave.announce || '')),
  afterLeave ? JSON.stringify(afterLeave.announce) : 'no announcement');

/* Bots jostle, so put the settler back on the market before asking again —
   the claim under test is about trading, not about standing still. */
await runTo(0, 0, 4, 40);
await sleep(900);

const tradeAfter = await ev(TRADE, true);
note('trade after', tradeAfter);
check('8. and the trading post still works for the one who stayed',
  !!(tradeAfter && tradeAfter.how === 'traded' && tradeAfter.moved > 0),
  `${tradeAfter && tradeAfter.how} ${tradeAfter && tradeAfter.reason} `
  + `(gave ${tradeAfter && tradeAfter.moved})`);

for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 180));

console.log('\n==========================================================');
console.log(`${passed}/${passed + failed} checks passed`);
for (const f of failures) console.log('  FAIL ' + f);
bye(failed ? 1 : 0);
