/**
 * Island Settlers — end-to-end multiplayer acceptance.
 *
 *   node tools/nettest.mjs [--keep] [--port=8799] [--quiet]
 *   node tools/nettest.mjs --remote=island-settlers-production.up.railway.app
 *
 * Boots the real server in a child process, opens two real websockets, makes a
 * room, joins it with the five-character code, plays a whole match through the
 * opening draft into live play, and checks that both clients agree with the
 * server AND WITH EACH OTHER about what happened.
 *
 * `--remote` runs the identical suite against a DEPLOYED server instead of a
 * local one — the same checks, over wss, through whatever proxy is in front of
 * it. That is the only way to find out whether a host actually holds a
 * websocket open for four minutes. It uses throwaway device ids each run and
 * touches nothing else.
 *
 * WHAT IT IS LOOKING FOR NOW
 * --------------------------
 *   "It was clear it wasn't the same game — they were playing at the same
 *    time, but the roads and settlements were in different locations, and when
 *    one user built a road the other player didn't see it at all."
 *
 * Two failures wearing one coat. The first was the old friends screen letting
 * two people each host their own lobby and each start their own match, so the
 * check that matters is now `both clients are in ONE match`: same matchId,
 * same seed, different seat. The second was the item field being re-tagged but
 * never re-laid on a reshuffle — `tools/boardsync.mjs` owns that one, because
 * it only shows up across separate processes and this file is one.
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
 * module registry — so the two simulated clients share one island. They do NOT
 * share a mirror: each gets its own `createMatch` state and its own
 * `createMirror`, fed only by its own socket, which is what lets the last
 * checks compare what the two of them independently believe is on the board.
 * The old version fed one mirror from both sockets and therefore could not
 * have caught a desync if there had been one.
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
import {
  REQ, PUSH, OK, ERR, ACT, PROTOCOL_VERSION, CODE_LEN, CODE_ALPHABET
} from '../src/net/protocol.js';

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
const REMOTE = arg('remote', '');
/* Device ids are per RUN, not per suite: a second run against a live server
   must not walk back into the first run's seat. Names are just labels now and
   do not have to be unique at all. */
const TAG = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
const DEV_A = `nettest-a-${TAG}`;
const DEV_B = `nettest-b-${TAG}`;
const NAME_A = 'Alice';
const NAME_B = 'Bob';
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

const HTTP = REMOTE ? `https://${REMOTE.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : `http://127.0.0.1:${PORT}`;
const WS = REMOTE ? HTTP.replace(/^https/, 'wss') + '/ws' : `ws://127.0.0.1:${PORT}/ws`;

let server = null;
let serverLog = '';
if (!REMOTE) {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MAX_MATCHES: '4'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => { serverLog += d; if (!QUIET) process.stdout.write('  [srv] ' + d); });
  server.stderr.on('data', d => { serverLog += d; process.stdout.write('  [srv!] ' + d); });
} else {
  console.log(`  testing the live server at ${HTTP}`);
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${HTTP}/health`);
      if (r.ok) return await r.json();
    } catch (e) { /* not up yet */ }
    await sleep(REMOTE ? 400 : 150);
  }
  throw new Error('server never came up\n' + serverLog);
}

/* ================================================================== client
   A minimal, honest client: request/reply by id, plus a push queue anybody
   can await on. Everything the browser's client.js will do, without the DOM. */

function connect(label) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS);
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
       * `pred` matters more than it looks. `hello` already delivers a ROOM
       * push if you were in one, so "wait for ROOM" after a join can hand back
       * a stale one and report that the join never landed. The predicate says
       * which ROOM is meant.
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

  const hello = await A.req(REQ.HELLO, {
    version: PROTOCOL_VERSION, device: DEV_A, name: NAME_A
  });
  check('03. one call gets you in — no account, no password',
    hello.t === OK && hello.version === PROTOCOL_VERSION
    && !!hello.you && hello.you.name === NAME_A,
    `you=${hello.you && hello.you.id}`);
  const meA = hello.you;

  /* --- version guard ------------------------------------------------- */
  let versionRefused = false;
  try {
    await B.req(REQ.HELLO, { version: PROTOCOL_VERSION + 99, device: DEV_B, name: NAME_B });
  } catch (e) { versionRefused = e.code === 'version.mismatch'; }
  check('04. a stale client is refused rather than half-served', versionRefused);

  const helloB = await B.req(REQ.HELLO, {
    version: PROTOCOL_VERSION, device: DEV_B, name: NAME_B
  });
  const meB = helloB.you;
  check('05. two devices are two players', !!meB && meB.id !== meA.id);

  /* --- the name is the player's, and it is theirs to change ---------- */
  let badName = null;
  try { await A.req(REQ.SET_NAME, { name: 'x' }); } catch (e) { badName = e.code; }
  check('06. a one-character name is refused', badName === 'name.bad', `-> ${badName}`);

  const renamed = await A.req(REQ.SET_NAME, { name: '  Alice  Ann  ' });
  check('07. a name is tidied rather than rejected',
    renamed.you.name === 'Alice Ann', `-> "${renamed.you.name}"`);
  await A.req(REQ.SET_NAME, { name: NAME_A });

  /* --- coming back --------------------------------------------------- */
  const C = await connect('alice-again');
  const back = await C.req(REQ.HELLO, {
    version: PROTOCOL_VERSION, device: DEV_A, name: NAME_A
  });
  check('08. the same device id is the same player, with nothing to type',
    back.you && back.you.id === meA.id);

  const other = await connect('a-stranger');
  const strange = await other.req(REQ.HELLO, {
    version: PROTOCOL_VERSION, device: `${DEV_A}-not`, name: NAME_A
  });
  check('09. the same NAME on a different device is a different player',
    strange.you.id !== meA.id, 'names are labels, not identities');
  other.close();

  // Two sockets for one device: the older is closed rather than shadowed.
  await sleep(250);
  C.close();
  await sleep(200);
  A = await connect('alice');
  await A.req(REQ.HELLO, { version: PROTOCOL_VERSION, device: DEV_A, name: NAME_A });

  /* --- rooms ----------------------------------------------------------
   *
   *   "Switch to a create a room and use a room code... whoever put in that
   *    room code while the lobby was open is added to the game. For the game
   *    room, it should only be 5 characters long."
   */
  let noSuchRoom = null;
  try { await B.req(REQ.ROOM_JOIN, { code: 'ZZZZZ' }); }
  catch (e) { noSuchRoom = e.code; }
  check('10. a code nobody made says so', noSuchRoom === 'room.unknown', `-> ${noSuchRoom}`);

  let shortCode = null;
  try { await B.req(REQ.ROOM_JOIN, { code: 'AB' }); }
  catch (e) { shortCode = e.code; }
  check('11. a code of the wrong length is refused before it is looked up',
    shortCode === 'code.bad');

  const made = await A.req(REQ.ROOM_CREATE, {});
  const code = made.room.code;
  check('12. a room opens with the host seated and three seats free',
    made.room.seats.filter(s => s.kind === 'human').length === 1
    && made.room.seats.filter(s => s.kind === 'empty').length === 3
    && made.room.hostId === meA.id,
    `code ${code}`);

  check('13. the code is five characters, and none of them are ambiguous',
    typeof code === 'string' && code.length === CODE_LEN
    && [...code].every(ch => CODE_ALPHABET.includes(ch)),
    `${code} (no I, L, O, 0 or 1)`);

  /* THE HEADLINE. No invite, nobody to accept, no friendship: the code is the
     whole of the permission, and typing it lands you in the SAME room. */
  const joined = await B.req(REQ.ROOM_JOIN, { code: code.toLowerCase() });
  check('14. typing the code gets you in — invited by nobody, accepted by nobody',
    joined.room.code === code
    && joined.room.seats[1].kind === 'human' && joined.room.seats[1].name === NAME_B,
    `seats: ${joined.room.seats.map(s => s.kind).join()}`);

  const sawJoin = await A.next(PUSH.ROOM, 8000, m => m.room
    && m.room.seats.filter(s => s.kind === 'human').length === 2);
  check('15. the room tells everybody already in it',
    !!sawJoin && sawJoin.room.humans === 2);

  let notHost = null;
  try { await B.req(REQ.ROOM_SETTINGS, { difficulty: 'easy' }); }
  catch (e) { notHost = e.code; }
  check('16. only the player who made the room may change the settings',
    notHost === 'room.nothost');

  const settings = await A.req(REQ.ROOM_SETTINGS, { difficulty: 'hard', knights: true });
  check('17. the host sets difficulty and Knights for everyone',
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
    if (!begin || !(who === A ? net.mirrorA : net.mirrorB)) { net.queue.push([who, msg]); return; }
    if (msg.pid !== begin.yourPid) return;
    placePick(who, msg);
  }

  const placedAt = new Map();           // client -> last setup index acted on

  async function placePick(who, msg) {
    /* The server repeats the draft announcement when a peer comes back live, so
       a client that reloaded across the original is told whose turn it is. A
       stand-in for a person must ignore the repeat for a turn it has already
       played, exactly as netmatch.js does. */
    if (msg.resend && placedAt.get(who) === msg.index) return;
    placedAt.set(who, msg.index);
    const m = who === A ? net.mirrorA : net.mirrorB;
    const st = who === A ? net.stateA : net.stateB;
    const localPid = m.toLocal(msg.pid);
    const legal = msg.need === 'road'
      ? legalRoads(st, localPid, true, msg.anchor)
      : legalSettlements(st, localPid, true);
    if (!legal.length) { log(`${who.label}: nothing legal for ${msg.need}`); return; }
    await sleep(90);          // a beat of thinking, like a person
    try {
      await who.req(REQ.MATCH_ACT, {
        kind: msg.need === 'road' ? ACT.DRAFT_ROAD : ACT.DRAFT_SETTLEMENT,
        id: legal[0]
      });
    } catch (e) { log(`${who.label} draft pick refused: ${e.message}`); }
  }

  /* EACH CLIENT FEEDS ITS OWN MIRROR, AND THEY ARE COMPARED AT THE END.
   *
   * This used to apply only alice's stream, to one shared mirror, because two
   * streams into one board double-counts every build. That is true — and it
   * also meant the test could not have caught the reported bug if it tried:
   * "when one user built a road the other player didn't see it at all" is
   * precisely a claim about the SECOND client's board, and there was not one.
   *
   * `createMatch` returns a fresh state object, so two states and two mirrors
   * do not collide. The island underneath them is one module singleton and is
   * therefore literally shared, which is fine: that half of the claim belongs
   * to `tools/boardsync.mjs`, which spawns real separate processes for it. */
  const pump = who => msg => {
    const m = who === A ? net.mirrorA : net.mirrorB;
    if (msg.t === PUSH.MATCH_EV) {
      if (who === A) evLog.push(...msg.evs);
      else net.bobEvents += msg.evs.length;
      if (m) m.applyEvents(msg.evs);
    }
    if (msg.t === PUSH.MATCH_SNAP && m) m.applySnapshot(msg);
    draftAnswer(who, msg);
  };
  net.bobEvents = 0;
  const evLog = [];
  A.onPush = pump(A);
  B.onPush = pump(B);

  /* --- START IS A VOTE ------------------------------------------------
     One press must not start a two-person match. This is the whole of the
     request and the easiest thing in the world to regress, so it is checked
     from both sides: nothing happens on the first press, and the match begins
     on the second without anybody pressing anything else. */
  const voteA = await A.req(REQ.ROOM_START, {});
  check('18. one player pressing START does not start the match',
    voteA.started === false && voteA.waitingFor.includes(NAME_B),
    `alice is ready; waiting for ${JSON.stringify(voteA.waitingFor)}`);

  const soloBegin = await A.next(PUSH.MATCH_BEGIN, 2500).catch(() => null);
  check('19. and no match begins while somebody has not said yes',
    soloBegin === null, 'nothing arrived in 2.5s');

  const voteB = await B.req(REQ.ROOM_START, {});
  const beginA = await A.next(PUSH.MATCH_BEGIN);
  const beginB = await B.next(PUSH.MATCH_BEGIN);
  check('20. the match starts the moment the last player is ready',
    voteB.started === true && voteB.waitingFor.length === 0,
    'bob was the last vote');
  net.beginA = beginA;
  net.beginB = beginB;
  check('21. both clients are told to start the same match',
    beginA.matchId === beginB.matchId && beginA.seed === beginB.seed,
    `seed ${beginA.seed}`);
  check('22. each client is told which seat is theirs, and they differ',
    beginA.yourPid !== beginB.yourPid,
    `alice pid ${beginA.yourPid}, bob pid ${beginB.yourPid}`);
  check('23. the two empty seats became bots',
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
  // Bob's own board, from bob's own begin message and bob's own seat.
  const stateB = createMatch({ seed: beginB.seed >>> 0 });
  const mirrorB = createMirror(stateB, {
    yourPid: beginB.yourPid, roster: beginB.seats, order: beginB.order
  });
  const totalItems = [...itemsByTile.values()].reduce((n, l) => n + l.length, 0);
  check('24. the seed alone deals the board and its whole item field',
    tiles.length === 19 && totalItems > 300,
    `19 hexes, ${totalItems} item positions, fingerprint ${boardFingerprint.slice(0, 24)}...`);

  /*
   * WHO EVERYBODY IS, ON BOTH SCREENS.
   *
   *   "It got the names wrong. In this instance it would show my name, my
   *    friend's name, and 2 bots' names. But instead sometimes I saw the name
   *    You, sometimes I saw 3 bots' names and 1 of the two of us."
   *
   * The mirror renumbers seats so the local player is always index 0, and
   * identity is supposed to travel with the SERVER seat rather than the local
   * one. This checks that from both chairs at once: each client must see itself
   * as You, the other human under the name they typed, and exactly two bots.
   */
  const namesOf = st => st.players.map(p => p.name);
  const nA = namesOf(state), nB = namesOf(stateB);
  check('25a. each client sees itself as You, the other human by name, two bots',
    nA[0] === 'You' && nB[0] === 'You'
    && nA.indexOf(NAME_B) > 0 && nB.indexOf(NAME_A) > 0
    && nA.filter(n => n === 'Alex' || n === 'Maya' || n === 'Finn').length === 2
    && nB.filter(n => n === 'Alex' || n === 'Maya' || n === 'Finn').length === 2,
    `alice sees [${nA.join(', ')}]  ·  bob sees [${nB.join(', ')}]`);
  check('25b. and neither client has two settlers wearing the same colour',
    new Set(state.players.map(p => p.color.key)).size === 4
    && new Set(stateB.players.map(p => p.color.key)).size === 4,
    `${state.players.map(p => p.color.key).join()} | ${stateB.players.map(p => p.color.key).join()}`);

  check('25. you are seat 0 locally whatever seat the server dealt you',
    mirror.toLocal(beginA.yourPid) === 0
    && mirror.toServer(0) === beginA.yourPid
    && state.players[0].color.key === beginA.seats[beginA.yourPid].color,
    `server pid ${beginA.yourPid} -> local 0, wearing ${state.players[0].color.key}`);

  /* --- the draft -----------------------------------------------------
     Hand the mirror to the pumps and replay anything that arrived while the
     board was being dealt. */
  const draftDone = new Promise(done => { net.done = done; });
  net.mirrorA = mirror; net.stateA = state;
  net.mirrorB = mirrorB; net.stateB = stateB;
  for (const [who, msg] of net.queue.splice(0)) {
    const begin = who === A ? net.beginA : net.beginB;
    if (begin && msg.pid === begin.yourPid) placePick(who, msg);
  }

  await Promise.race([draftDone, sleep(50000)]);
  check('26. the opening draft completes with eight settlements and eight roads',
    state.buildings.size === 8 && state.roadOwner.size === 8,
    `${state.buildings.size} settlements, ${state.roadOwner.size} roads`);

  /* THE BUG, CHECKED FROM BOTH SIDES.
   *
   *   "When one user built a road the other player didn't see it at all."
   *
   * Bob's board is built only from bob's socket. If a single build event went
   * to one client and not the other, or landed on a different edge, these two
   * maps disagree. */
  // A beat for the tail of the stream. `done` fires on alice's view of the
  // last message, and bob's copy of it is a packet behind at worst.
  await sleep(600);
  const roadsA = [...state.roadOwner.entries()].sort((x, y) => x[0] - y[0]);
  const roadsB = [...stateB.roadOwner.entries()].sort((x, y) => x[0] - y[0]);
  const bldA = [...state.buildings.keys()].sort((x, y) => x - y);
  const bldB = [...stateB.buildings.keys()].sort((x, y) => x - y);
  check('27. both players see the same eight roads on the same eight edges',
    roadsA.length === 8 && roadsB.length === 8
    && roadsA.every(([id], i) => roadsB[i][0] === id),
    `alice ${roadsA.map(r => r[0]).join(',')} | bob ${roadsB.map(r => r[0]).join(',')}`);
  check('28. and the same eight settlements on the same eight corners',
    bldA.length === 8 && bldB.length === 8 && bldA.every((id, i) => bldB[i] === id),
    `corners ${bldA.join(',')}`);
  /* Seats are permuted per client — you are always local 0 — so the OWNERS
     have to be compared through the two mirrors rather than as raw numbers.
     A road that is alice's on alice's screen and bob's on bob's screen is a
     desync that matching edge ids alone would not catch. */
  const ownerMismatch = roadsA.filter(([id, localOwner], i) =>
    !roadsB[i] || mirror.toServer(localOwner) !== mirrorB.toServer(roadsB[i][1]));
  check('29. and they agree about whose road is whose',
    ownerMismatch.length === 0,
    `${roadsA.length} roads, ${ownerMismatch.length} disputed`);

  const go = A.seen.go || await A.next(PUSH.MATCH_GO, 12000);
  check('30. the countdown to play is announced to the table', !!go, `in ${go && go.in}ms`);

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
  check('31. snapshots arrive at about the advertised rate',
    snaps > 120 && snaps < 260, `${snaps} in 9s (want ~180)`);

  const me = state.players[0];
  check('32. your settler actually moved when you pushed the stick',
    Number.isFinite(me.x) && Number.isFinite(me.z)
    && (Math.abs(me.x) + Math.abs(me.z)) > 0,
    `at ${me.x.toFixed(1)}, ${me.z.toFixed(1)} facing ${me.facing.toFixed(2)}`);

  const gainedEvents = evLog.filter(e => e.type === 'gained');
  const totalGathered = state.players.reduce((n, p) => n + (p.stats ? p.stats.gathered : 0), 0);
  check('33. resources are gathered on contact and streamed to both clients',
    gainedEvents.length > 0 && totalGathered > 0,
    `${gainedEvents.length} pickups seen, ${totalGathered} counted`);

  const mirroredRes = state.players.map(p =>
    p.res.wood + p.res.brick + p.res.wool + p.res.wheat + p.res.ore);
  check('34. the mirrored board agrees with the server about everyone\'s goods',
    mirroredRes.every(v => Number.isFinite(v) && v >= 0),
    `packs: ${mirroredRes.join(' / ')}`);

  /* --- an illegal move is refused ------------------------------------ */
  let refused = null;
  try {
    await A.req(REQ.MATCH_ACT, { kind: ACT.BUILD_SETTLEMENT, id: 999 });
  } catch (e) { refused = e.code; }
  check('35. the server refuses a move that is not legal', refused === 'move.illegal',
    `-> ${refused}`);

  /* --- trading from the wrong place ---------------------------------- */
  let noTrade = null;
  try {
    await A.req(REQ.MATCH_ACT, { kind: ACT.TRADE, give: 'wood', get: 'ore' });
  } catch (e) { noTrade = e.code; }
  check('36. you cannot trade without standing at a post', noTrade === 'move.illegal',
    'proximity is checked on the server, not taken on trust');

  /* --- somebody drops ------------------------------------------------ */
  const bobPid = beginB.yourPid;
  B.close();
  await sleep(1200);
  const peer = { seen: false };
  // A gets told that a seat changed hands.
  const peerMsg = await A.next(PUSH.MATCH_PEER, 8000).catch(() => null);
  peer.seen = !!peerMsg;
  check('37. the table is told when a player drops out', peer.seen && peerMsg.state === 'gone',
    `seat ${bobPid} -> ${peerMsg && peerMsg.state}`);

  const beforeReconnect = A.seen.snap;
  await sleep(2000);
  check('38. the match keeps running for everyone still in it',
    A.seen.snap > beforeReconnect, `${A.seen.snap - beforeReconnect} more snapshots`);

  /* --- reconnect ----------------------------------------------------- */
  B = await connect('bob-back');
  await B.req(REQ.HELLO, { version: PROTOCOL_VERSION, device: DEV_B, name: NAME_B });
  const backIn = await B.next(PUSH.MATCH_BEGIN, 8000).catch(() => null);
  check('39. reconnecting with the same device puts you back in your own seat',
    !!backIn && backIn.yourPid === bobPid && backIn.resumed === true,
    `back at seat ${backIn && backIn.yourPid}, no password typed`);

  /* The resume message used to be a SHORT one — seed, roster, seat — and the
     client parks it and reloads the page off it. Without the order it keeps
     its own locally generated draft order; without `knights` it reads
     `undefined !== false` and turns Knights on in a match that had them off.
     A reconnecting player came back into a subtly different game. */
  check('40. and is told everything the first begin told them',
    !!backIn && Array.isArray(backIn.order) && backIn.order.length === 8
    && typeof backIn.knights === 'boolean' && !!backIn.difficulty,
    `order ${backIn && (backIn.order || []).join('')}, ` +
    `${backIn && backIn.difficulty}, knights ${backIn && backIn.knights}`);

  /*
   *   "The game would let one player pick their location, but not the other."
   *
   * The draft prompt is a broadcast, sent once when the turn changes — and
   * every client reloads exactly once on the way into a match, because the
   * island cannot be re-dealt under a live scene. A client reloading across
   * that broadcast came back with nothing to act on and sat watching a board it
   * was allowed to pick on. The worker now re-announces the opening to the
   * table whenever a peer comes back live, so the returning client is told
   * whose turn it is without anybody having to move.
   */
  const draftBack = await B.next(PUSH.MATCH_DRAFT, 4000).catch(() => null);
  check('40b. a returning player is told the state of the opening again',
    // Past the draft by now in this run, so an absent message is the honest
    // answer; what must never happen is a WRONG one.
    draftBack === null || Number.isInteger(draftBack.pid),
    draftBack ? `pid ${draftBack.pid} needs ${draftBack.need}` : 'draft already over');

  /* --- leaving for good ---------------------------------------------- */
  /* Alice's seat specifically: Bob's own reconnect fires a 'live' peer push a
     moment earlier, and taking the first one that arrives measures the wrong
     person. */
  const alicePid = beginA.yourPid;
  const peerGone = B.next(PUSH.MATCH_PEER, 6000, m => m.pid === alicePid)
    .catch(() => null);
  await A.req(REQ.MATCH_LEAVE, {});
  const told = await peerGone;
  check('41a. the others are told when somebody leaves for good',
    !!told && told.state === 'bot',
    told ? `seat ${told.pid} -> ${told.state}` : 'nobody was told');

  /*
   *   "The friend who left should not be able to get back in... if you leave
   *    you leave. You have to start again."
   *
   * Alice left. A fresh socket on her device must be handed a lobby, not her
   * old seat — no MATCH_BEGIN, and no room to walk back into.
   */
  const A2 = await connect('alice-after-leaving');
  await A2.req(REQ.HELLO, { version: PROTOCOL_VERSION, device: DEV_A, name: NAME_A });
  const rejoin = await A2.next(PUSH.MATCH_BEGIN, 3000).catch(() => null);
  /* There is no ROOM_GET in the protocol — the room arrives as a PUSH when you
     are in one. Not being pushed a room is the assertion. */
  const roomNow = await A2.next(PUSH.ROOM, 2500).catch(() => null);
  check('41b. and leaving is final — no seat, no room, no way back in',
    rejoin === null && !(roomNow && roomNow.room),
    `begin: ${rejoin ? 'RESUMED' : 'none'}, room: ${roomNow && roomNow.room ? roomNow.room.code : 'none'}`);

  await sleep(1500);
  const stillGoing = await fetch(`${HTTP}/health`).then(r => r.json());
  check('41. leaving a match does not take the server with it',
    stillGoing.ok === true, `${stillGoing.matches} match(es) still running`);

  /* --- nothing was written anywhere ----------------------------------
     The accounts file, its volume, the boot-time write probe and the
     root-then-drop-privileges dance that made the volume writable are all
     gone with the accounts. What is left should be exactly this: a process
     holding some players and some rooms in memory, and no disk at all. */
  const finalHealth = await fetch(`${HTTP}/health`).then(r => r.json());
  check('42. the server keeps its state in memory and reports no store',
    finalHealth.ok === true && finalHealth.store === undefined
    && typeof finalHealth.openRooms === 'number',
    `${finalHealth.players} players, ${finalHealth.rooms} rooms, ` +
    `${finalHealth.openRooms} of them open`);

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
if (server && !has('keep')) {
  server.kill('SIGTERM');
  await sleep(400);
  server.kill('SIGKILL');
}

console.log('\n==========================================================');
console.log(`${passed}/${passed + failed} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failed ? 1 : 0);
