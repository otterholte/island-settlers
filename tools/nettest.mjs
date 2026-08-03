/**
 * Island Settlers — end-to-end multiplayer acceptance.
 *
 *   node tools/nettest.mjs [--keep] [--port=8799] [--quiet]
 *
 * Boots the real server in a child process, opens two real websockets, signs
 * up two accounts, makes them friends, invites one to the other's lobby, plays
 * a whole match through the opening draft into live play, and checks that both
 * clients agree with the server about what happened.
 *
 * WHY IT DRIVES THE REAL CLIENT CODE
 * ----------------------------------
 * The mirror in `src/net/mirror.js` is the file that decides whether a
 * networked board looks like the server's board, and it is headless on
 * purpose. This test imports THAT file rather than reimplementing what it
 * does, so a bug in the thing the browser runs is a failing check here.
 *
 * THE ONE THING IT CANNOT DO
 * --------------------------
 * Hold two boards. `board/layout.js` is a module singleton — one island per
 * module registry — so both simulated clients share one mirrored board. That
 * is fine for what this proves (two real sockets, one real server, one real
 * worker) and it is exactly why the SERVER puts each match in its own worker.
 *
 * Owner: net agent.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, mkdirSync } from 'node:fs';

import { createMatch, legalSettlements, legalRoads, scoreOf } from '../src/core/rules.js';
import { reshuffle, tiles } from '../src/board/layout.js';
import { itemsByTile } from '../src/board/nodes.js';
import { createMirror } from '../src/net/mirror.js';
import { REQ, PUSH, OK, ERR, ACT, PROTOCOL_VERSION } from '../src/net/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const has = k => process.argv.includes(`--${k}`);

const PORT = Number(arg('port', 8799));
const DATA = resolve(arg('data', '/tmp/island-nettest'));
const QUIET = has('quiet');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a) => { if (!QUIET) console.log(' ', ...a); };

let passed = 0, failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`FAIL  ${name}  ${detail}`); }
  return ok;
}

/* ================================================================== server */

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA,
    SESSION_SECRET: 'nettest-secret-value-long-enough',
    MAX_MATCHES: '4'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; if (!QUIET) process.stdout.write('  [srv] ' + d); });
server.stderr.on('data', d => { serverLog += d; process.stdout.write('  [srv!] ' + d); });

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return await r.json();
    } catch (e) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server never came up\n' + serverLog);
}

/* ================================================================== client
   A minimal, honest client: request/reply by id, plus a push queue anybody
   can await on. Everything the browser's client.js will do, without the DOM. */

function connect(label) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let nextId = 1;
    const waiting = new Map();
    const pushes = [];
    const watchers = [];
    const seen = { snap: 0, ev: 0, begin: null, draft: null, over: null, go: null };

    const api = {
      label, ws, seen,
      req(t, body = {}) {
        const i = nextId++;
        return new Promise((ok, no) => {
          const timer = setTimeout(() => {
            waiting.delete(i);
            no(new Error(`${label}: ${t} timed out`));
          }, 15000);
          waiting.set(i, { ok, no, timer, t });
          ws.send(JSON.stringify({ i, t, ...body }));
        });
      },
      fire(t, body = {}) { ws.send(JSON.stringify({ t, ...body })); },
      /**
       * Wait for the next push of a given type, or throw.
       *
       * `pred` matters more than it looks. Signing in already delivers a
       * FRIENDS push, so "wait for FRIENDS" after sending a friend request
       * hands back the empty one that arrived at sign-up and reports that the
       * request never landed. The predicate says which FRIENDS is meant.
       */
      next(type, ms = 15000, pred = null) {
        const ok0 = m => m.t === type && (!pred || pred(m));
        const at = pushes.findIndex(ok0);
        if (at >= 0) return Promise.resolve(pushes.splice(at, 1)[0]);
        return new Promise((ok, no) => {
          const w = { type, pred, no };
          const timer = setTimeout(() => {
            const at2 = watchers.indexOf(w);
            if (at2 >= 0) watchers.splice(at2, 1);
            no(new Error(`${label}: no ${type} within ${ms}ms`));
          }, ms);
          w.ok = v => { clearTimeout(timer); ok(v); };
          watchers.push(w);
        });
      },
      onPush: null,
      close() { try { ws.close(); } catch (e) { /* fine */ } }
    };

    ws.onopen = () => res(api);
    ws.onerror = e => rej(new Error(`${label}: socket error`));
    ws.onmessage = m => {
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg.i !== undefined && waiting.has(msg.i)) {
        const w = waiting.get(msg.i);
        waiting.delete(msg.i);
        clearTimeout(w.timer);
        if (msg.t === ERR) w.no(Object.assign(new Error(`${w.t} -> ${msg.code}`), { code: msg.code }));
        else w.ok(msg);
        return;
      }
      if (msg.t === PUSH.MATCH_SNAP) seen.snap++;
      if (msg.t === PUSH.MATCH_EV) seen.ev += (msg.evs || []).length;
      if (msg.t === PUSH.MATCH_BEGIN) seen.begin = msg;
      if (msg.t === PUSH.MATCH_DRAFT) seen.draft = msg;
      if (msg.t === PUSH.MATCH_GO) seen.go = msg;
      if (msg.t === PUSH.MATCH_OVER) seen.over = msg;
      if (api.onPush) { try { api.onPush(msg); } catch (e) { /* keep pumping */ } }
      const at = watchers.findIndex(w => w.type === msg.t && (!w.pred || w.pred(msg)));
      if (at >= 0) { const w = watchers.splice(at, 1)[0]; w.ok(msg); return; }
      pushes.push(msg);
      if (pushes.length > 400) pushes.splice(0, 200);
    };
  });
}

/* ==================================================================== run */

const t0 = Date.now();
let A = null, B = null;

try {
  const health = await waitForServer();
  check('01. server boots and answers /health',
    health.ok === true && health.protocol === PROTOCOL_VERSION,
    `protocol v${health.protocol}, matchCap ${health.matchCap}`);

  A = await connect('alice');
  B = await connect('bob');
  check('02. two websockets connect', !!A && !!B);

  const hello = await A.req(REQ.HELLO, { version: PROTOCOL_VERSION });
  check('03. handshake agrees on the protocol version',
    hello.t === OK && hello.version === PROTOCOL_VERSION);

  /* --- version guard ------------------------------------------------- */
  let versionRefused = false;
  try { await B.req(REQ.HELLO, { version: PROTOCOL_VERSION + 99 }); }
  catch (e) { versionRefused = e.code === 'version.mismatch'; }
  check('04. a stale client is refused rather than half-served', versionRefused);
  await B.req(REQ.HELLO, { version: PROTOCOL_VERSION });

  /* --- accounts ------------------------------------------------------ */
  const regA = await A.req(REQ.REGISTER, { name: 'alice', pass: 'islandpass' });
  const regB = await B.req(REQ.REGISTER, { name: 'bob', pass: 'islandpass' });
  check('05. two accounts register and get session tokens',
    !!regA.token && !!regB.token && regA.user.name === 'alice',
    `alice=${regA.user.id} bob=${regB.user.id}`);

  let dupe = null;
  try { await A.req(REQ.REGISTER, { name: 'ALICE', pass: 'somethingelse' }); }
  catch (e) { dupe = e.code; }
  check('06. names are unique regardless of case', dupe === 'name.taken', `-> ${dupe}`);

  let shortPass = null;
  try { await A.req(REQ.REGISTER, { name: 'carol', pass: 'abc' }); }
  catch (e) { shortPass = e.code; }
  check('07. a short password is refused', shortPass === 'pass.bad');

  /* --- resume -------------------------------------------------------- */
  const C = await connect('alice-again');
  await C.req(REQ.HELLO, { version: PROTOCOL_VERSION });
  const resumed = await C.req(REQ.RESUME, { token: regA.token });
  check('08. a saved token signs you back in without a password',
    resumed.user && resumed.user.id === regA.user.id);
  let badToken = null;
  try { await C.req(REQ.RESUME, { token: regA.token.slice(0, -3) + 'xxx' }); }
  catch (e) { badToken = e.code; }
  check('09. a tampered token is refused', badToken === 'auth.bad');
  // Signing in twice closes the older socket; A is now the dead one.
  await sleep(200);
  C.close();
  await sleep(200);

  // Reconnect A properly for the rest of the run.
  A = await connect('alice');
  await A.req(REQ.HELLO, { version: PROTOCOL_VERSION });
  await A.req(REQ.RESUME, { token: regA.token });

  /* --- friends ------------------------------------------------------- */
  let noSuch = null;
  try { await A.req(REQ.FRIEND_ADD, { name: 'nobody' }); }
  catch (e) { noSuch = e.code; }
  check('10. adding a name that does not exist says so', noSuch === 'user.unknown');

  let self = null;
  try { await A.req(REQ.FRIEND_ADD, { name: 'alice' }); }
  catch (e) { self = e.code; }
  check('11. you cannot friend yourself', self === 'friend.self');

  const sent = await A.req(REQ.FRIEND_ADD, { name: 'bob' });
  check('12. a friend request is sent, not silently accepted', sent.status === 'sent');

  const bobsList = await B.next(PUSH.FRIENDS, 8000, m => m.incoming.length > 0);
  check('13. the request lands on the other side live',
    bobsList.incoming.length === 1 && bobsList.incoming[0].name === 'alice');
  check('14. an unanswered request grants nothing',
    bobsList.friends.length === 0);

  await B.req(REQ.FRIEND_ACCEPT, { id: regA.user.id });
  const aliceList = await A.next(PUSH.FRIENDS, 8000, m => m.friends.length > 0);
  check('15. accepting makes the friendship mutual and shows presence',
    aliceList.friends.length === 1
    && aliceList.friends[0].name === 'bob'
    && aliceList.friends[0].online === true,
    `alice sees ${aliceList.friends.map(f => f.name + (f.online ? '(on)' : '(off)')).join()}`);

  /* --- lobby --------------------------------------------------------- */
  const made = await A.req(REQ.ROOM_CREATE, {});
  const roomId = made.room.id;
  check('16. a lobby opens with the host seated and three seats free',
    made.room.seats.filter(s => s.kind === 'human').length === 1
    && made.room.seats.filter(s => s.kind === 'empty').length === 3
    && made.room.hostId === regA.user.id,
    `room ${roomId}`);

  let uninvited = null;
  try { await B.req(REQ.ROOM_JOIN, { roomId }); }
  catch (e) { uninvited = e.code; }
  check('17. a lobby is invite-only even if you know the code',
    uninvited === 'friend.none', `-> ${uninvited}`);

  await A.req(REQ.ROOM_INVITE, { userId: regB.user.id });
  const invite = await B.next(PUSH.INVITE);
  check('18. the invite arrives with who sent it',
    invite.roomId === roomId && invite.from.name === 'alice');

  const joined = await B.req(REQ.ROOM_JOIN, { roomId });
  check('19. the invited friend takes the next seat',
    joined.room.seats[1].kind === 'human' && joined.room.seats[1].name === 'bob',
    `seats: ${joined.room.seats.map(s => s.kind).join()}`);

  let notHost = null;
  try { await B.req(REQ.ROOM_SETTINGS, { difficulty: 'easy' }); }
  catch (e) { notHost = e.code; }
  check('20. only the host may change the settings', notHost === 'room.nothost');

  const settings = await A.req(REQ.ROOM_SETTINGS, { difficulty: 'hard', knights: true });
  check('21. the host sets difficulty and Knights for everyone',
    settings.room.settings.difficulty === 'hard' && settings.room.settings.knights === true);

  /* --- the match -----------------------------------------------------
     The pumps go on BEFORE start. The worker posts `begin` and the first
     `draft` in the same breath, so a handler installed after awaiting `begin`
     has already missed the first turn — which is not a harmless race: the
     server waits out the whole thirty-second pick clock before auto-placing,
     and the run dies of old age with one settlement on the board. */
  const net = { mirror: null, state: null, queue: [] };

  function draftAnswer(who, msg) {
    if (!msg || msg.t !== PUSH.MATCH_DRAFT) return;
    if (msg.need === 'done') { net.done && net.done(); return; }
    const begin = who === A ? net.beginA : net.beginB;
    // Not knowing your own seat yet is exactly as much a reason to hold the
    // message as not having a board yet. Dropping it here is what made the
    // first run sit out the whole pick clock.
    if (!begin || !net.mirror) { net.queue.push([who, msg]); return; }
    if (msg.pid !== begin.yourPid) return;
    placePick(who, msg);
  }

  async function placePick(who, msg) {
    const localPid = net.mirror.toLocal(msg.pid);
    const legal = msg.need === 'road'
      ? legalRoads(net.state, localPid, true, msg.anchor)
      : legalSettlements(net.state, localPid, true);
    if (!legal.length) { log(`${who.label}: nothing legal for ${msg.need}`); return; }
    await sleep(90);          // a beat of thinking, like a person
    try {
      await who.req(REQ.MATCH_ACT, {
        kind: msg.need === 'road' ? ACT.DRAFT_ROAD : ACT.DRAFT_SETTLEMENT,
        id: legal[0]
      });
    } catch (e) { log(`${who.label} draft pick refused: ${e.message}`); }
  }

  /* ONLY ONE CLIENT FEEDS THE MIRROR.
     Both sockets receive the same event stream, and there is one shared board
     in this process because `board/layout.js` is a module singleton. Applying
     both streams to it double-counts every build, which walks the draft cursor
     forward twice per road and hands the next player a set of legal spots
     computed against a board a whole turn ahead of the server's. In a browser
     this cannot happen — each client is its own process with its own island —
     which is exactly why the server puts each match in its own worker. */
  const pump = who => msg => {
    if (who === A && msg.t === PUSH.MATCH_EV && net.mirror) {
      evLog.push(...msg.evs);
      net.mirror.applyEvents(msg.evs);
    }
    if (who === A && msg.t === PUSH.MATCH_SNAP && net.mirror) net.mirror.applySnapshot(msg);
    if (who === B && msg.t === PUSH.MATCH_EV) net.bobEvents += msg.evs.length;
    draftAnswer(who, msg);
  };
  net.bobEvents = 0;
  const evLog = [];
  A.onPush = pump(A);
  B.onPush = pump(B);

  await A.req(REQ.ROOM_START, {});
  const beginA = await A.next(PUSH.MATCH_BEGIN);
  const beginB = await B.next(PUSH.MATCH_BEGIN);
  net.beginA = beginA;
  net.beginB = beginB;
  check('22. both clients are told to start the same match',
    beginA.matchId === beginB.matchId && beginA.seed === beginB.seed,
    `seed ${beginA.seed}`);
  check('23. each client is told which seat is theirs, and they differ',
    beginA.yourPid !== beginB.yourPid,
    `alice pid ${beginA.yourPid}, bob pid ${beginB.yourPid}`);
  check('24. the two empty seats became bots',
    beginA.seats.filter(s => s.kind === 'bot').length === 2
    && beginA.seats.filter(s => s.kind === 'human').length === 2,
    beginA.seats.map(s => `${s.pid}:${s.kind}`).join(' '));

  /* Deal the same island the server dealt, from the seed alone. This is the
     claim the whole design rests on, so it is checked rather than assumed. */
  reshuffle(beginA.seed >>> 0);
  const boardFingerprint = tiles.map(t => `${t.terrain[0]}${t.number}`).join('');
  const state = createMatch({ seed: beginA.seed >>> 0 });
  const mirror = createMirror(state, {
    yourPid: beginA.yourPid, roster: beginA.seats, order: beginA.order
  });
  const totalItems = [...itemsByTile.values()].reduce((n, l) => n + l.length, 0);
  check('25. the seed alone deals the board and its whole item field',
    tiles.length === 19 && totalItems > 300,
    `19 hexes, ${totalItems} item positions, fingerprint ${boardFingerprint.slice(0, 24)}...`);

  check('26. you are seat 0 locally whatever seat the server dealt you',
    mirror.toLocal(beginA.yourPid) === 0
    && mirror.toServer(0) === beginA.yourPid
    && state.players[0].color.key === beginA.seats[beginA.yourPid].color,
    `server pid ${beginA.yourPid} -> local 0, wearing ${state.players[0].color.key}`);

  /* --- the draft -----------------------------------------------------
     Hand the mirror to the pumps and replay anything that arrived while the
     board was being dealt. */
  const draftDone = new Promise(done => { net.done = done; });
  net.mirror = mirror;
  net.state = state;
  for (const [who, msg] of net.queue.splice(0)) {
    const begin = who === A ? net.beginA : net.beginB;
    if (begin && msg.pid === begin.yourPid) placePick(who, msg);
  }

  await Promise.race([draftDone, sleep(50000)]);
  check('27. the opening draft completes with eight settlements and eight roads',
    state.buildings.size === 8 && state.roadOwner.size === 8,
    `${state.buildings.size} settlements, ${state.roadOwner.size} roads`);

  const go = A.seen.go || await A.next(PUSH.MATCH_GO, 12000);
  check('28. the countdown to play is announced to the table', !!go, `in ${go && go.in}ms`);

  /* --- play ---------------------------------------------------------- */
  const snapsBefore = A.seen.snap;
  // Run at each other for a few seconds and let the servers' settlers gather.
  const drive = setInterval(() => {
    const a = Math.sin(Date.now() / 700), b = Math.cos(Date.now() / 900);
    A.fire(REQ.MATCH_INPUT, { x: a, z: b, q: 0 });
    B.fire(REQ.MATCH_INPUT, { x: -b, z: a, q: 0 });
  }, 1000 / 20);
  await sleep(9000);
  clearInterval(drive);

  const snaps = A.seen.snap - snapsBefore;
  check('29. snapshots arrive at about the advertised rate',
    snaps > 120 && snaps < 260, `${snaps} in 9s (want ~180)`);

  const me = state.players[0];
  check('30. your settler actually moved when you pushed the stick',
    Number.isFinite(me.x) && Number.isFinite(me.z)
    && (Math.abs(me.x) + Math.abs(me.z)) > 0,
    `at ${me.x.toFixed(1)}, ${me.z.toFixed(1)} facing ${me.facing.toFixed(2)}`);

  const gainedEvents = evLog.filter(e => e.type === 'gained');
  const totalGathered = state.players.reduce((n, p) => n + (p.stats ? p.stats.gathered : 0), 0);
  check('31. resources are gathered on contact and streamed to both clients',
    gainedEvents.length > 0 && totalGathered > 0,
    `${gainedEvents.length} pickups seen, ${totalGathered} counted`);

  const mirroredRes = state.players.map(p =>
    p.res.wood + p.res.brick + p.res.wool + p.res.wheat + p.res.ore);
  check('32. the mirrored board agrees with the server about everyone\'s goods',
    mirroredRes.every(v => Number.isFinite(v) && v >= 0),
    `packs: ${mirroredRes.join(' / ')}`);

  /* --- an illegal move is refused ------------------------------------ */
  let refused = null;
  try {
    await A.req(REQ.MATCH_ACT, { kind: ACT.BUILD_SETTLEMENT, id: 999 });
  } catch (e) { refused = e.code; }
  check('33. the server refuses a move that is not legal', refused === 'move.illegal',
    `-> ${refused}`);

  /* --- trading from the wrong place ---------------------------------- */
  let noTrade = null;
  try {
    await A.req(REQ.MATCH_ACT, { kind: ACT.TRADE, give: 'wood', get: 'ore' });
  } catch (e) { noTrade = e.code; }
  check('34. you cannot trade without standing at a post', noTrade === 'move.illegal',
    'proximity is checked on the server, not taken on trust');

  /* --- somebody drops ------------------------------------------------ */
  const bobPid = beginB.yourPid;
  B.close();
  await sleep(1200);
  const peer = { seen: false };
  // A gets told that a seat changed hands.
  const peerMsg = await A.next(PUSH.MATCH_PEER, 8000).catch(() => null);
  peer.seen = !!peerMsg;
  check('35. the table is told when a player drops out', peer.seen && peerMsg.state === 'gone',
    `seat ${bobPid} -> ${peerMsg && peerMsg.state}`);

  const beforeReconnect = A.seen.snap;
  await sleep(2000);
  check('36. the match keeps running for everyone still in it',
    A.seen.snap > beforeReconnect, `${A.seen.snap - beforeReconnect} more snapshots`);

  /* --- reconnect ----------------------------------------------------- */
  B = await connect('bob-back');
  await B.req(REQ.HELLO, { version: PROTOCOL_VERSION });
  await B.req(REQ.RESUME, { token: regB.token });
  const backIn = await B.next(PUSH.MATCH_BEGIN, 8000).catch(() => null);
  check('37. reconnecting puts you back in your own seat',
    !!backIn && backIn.yourPid === bobPid && backIn.resumed === true,
    `back at seat ${backIn && backIn.yourPid}`);

  /* --- leaving for good ---------------------------------------------- */
  await A.req(REQ.MATCH_LEAVE, {});
  await sleep(1500);
  const stillGoing = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json());
  check('38. leaving a match does not take the server with it',
    stillGoing.ok === true, `${stillGoing.matches} match(es) still running`);

  /* --- persistence --------------------------------------------------- */
  const finalHealth = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json());
  check('39. the accounts were written to disk',
    finalHealth.users === 2 && finalHealth.store.writes > 0,
    `${finalHealth.users} accounts, ${finalHealth.store.writes} writes`);

} catch (e) {
  failed++;
  failures.push('harness');
  console.log(`FAIL  harness threw: ${e && e.message}`);
  if (e && e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
}

/* =================================================================== done */

try { A && A.close(); } catch (e) { /* fine */ }
try { B && B.close(); } catch (e) { /* fine */ }
await sleep(300);
if (!has('keep')) {
  server.kill('SIGTERM');
  await sleep(400);
  server.kill('SIGKILL');
}

console.log('\n==========================================================');
console.log(`${passed}/${passed + failed} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failed ? 1 : 0);
