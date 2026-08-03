/**
 * Island Settlers — the wire protocol.
 *
 * ONE FILE, BOTH ENDS. The browser imports this and so does the Node server
 * (`server/*.mjs` reaches back into `../src/net/protocol.js`). There is no
 * build step and no code generation, so the only way to stop a client and a
 * server disagreeing about a message name is for there to be exactly one
 * place the names are written down. This is that place.
 *
 * Headless-safe: no DOM, no three.js, no imports at all.
 *
 * ---------------------------------------------------------------------------
 * The shape of a message
 * ---------------------------------------------------------------------------
 * Every frame is JSON. Two flavours:
 *
 *   REQUEST / REPLY   client -> { i: 7, t: 'room.join', code: 'K4XPT' }
 *                     server -> { i: 7, t: 'ok', ... }  or  { i: 7, t: 'err', code, message }
 *
 *   PUSH              server -> { t: 'room', room: {...} }            (no `i`)
 *
 * `i` is a client-chosen request id. The server echoes it and never invents
 * one. Anything without an `i` is unsolicited and the client routes it by `t`.
 *
 * ---------------------------------------------------------------------------
 * Why a websocket and not REST
 * ---------------------------------------------------------------------------
 * The game is served from GitHub Pages and the server lives somewhere else
 * entirely, so every HTTP call would be cross-origin and would need CORS
 * preflights, credentials rules and a second auth path for the socket anyway.
 * A websocket is not subject to CORS, carries the session for its whole life,
 * and is already required for the match. So EVERYTHING goes down it. One
 * connection, one code path, one place session state lives.
 *
 * ---------------------------------------------------------------------------
 * There are no accounts
 * ---------------------------------------------------------------------------
 *   "Remove adding friends, remove accepting players, just say whoever put in
 *    that room code while the lobby was open is added to the game. But users
 *    can still add their name and it stays saved locally on the device."
 *
 * So the identity is a random id the browser generates once and keeps in
 * localStorage, and a display name the player typed on their own machine. Both
 * ride along on `hello`. The server holds them for as long as the process runs
 * and persists nothing: there is no password to get wrong, no token to expire,
 * no session secret to misconfigure, and a redeploy cannot silently sign
 * anybody out of a match, because there was never anything to sign in to.
 *
 * The device id is what makes a reload work. Same id, same seat.
 *
 * ---------------------------------------------------------------------------
 * How a match stays in sync
 * ---------------------------------------------------------------------------
 * The server is authoritative and the client is a renderer with an opinion.
 *
 *   THE BOARD IS A SEED. `board/layout.js`'s reshuffle(seed) is deterministic,
 *   and `board/nodes.js` re-lays its item field from tile id and number every
 *   time the board changes. So the server sends ONE NUMBER and both ends deal
 *   a byte-identical island down to which blade of wheat is at which
 *   coordinate. Nothing about the terrain, the tokens, the docks or the 576
 *   pickups is ever on the wire.
 *
 *   That "every time the board changes" was a lie for the whole first version
 *   of multiplayer — the field was laid once, at module load, from a throwaway
 *   random board, and never recomputed. Same terrain, different trees on every
 *   screen, and a pickup replayed by item id landed thirty metres from where it
 *   happened. `tools/boardsync.mjs` now proves the claim in separate processes
 *   rather than trusting this paragraph.
 *
 *   MUTATIONS ARE EVENTS. The server runs the real `core/rules.js` and streams
 *   the events it emits. The client replays each one through the same rules
 *   functions, which means every existing sound, particle, structure spawn and
 *   HUD flash fires exactly as it does in single player. The netcode adds no
 *   presentation code because it does not need any.
 *
 *   POSITIONS ARE A SNAPSHOT. Continuous things — where four settlers are —
 *   cannot be events, so they go in a fixed-rate snapshot: your own seat to
 *   correct your prediction, everyone else's to interpolate toward.
 *
 * Owner: net agent.
 */

/** Bumped whenever a message changes shape. A mismatch refuses the connection
 *  rather than half-working: an old tab against a new server is a bug report
 *  nobody can read. */
export const PROTOCOL_VERSION = 2;

/* ===================================================================== rates
   The simulation runs at 60Hz on the server because that is what the game is
   built on and nothing else would reproduce its feel. It does NOT broadcast at
   60Hz — four settlers times sixty frames is sixty times more traffic than the
   eye can use. 20Hz of positions with interpolation is indistinguishable from
   60 and costs a third of the bandwidth of even 30. */
export const SIM_HZ = 60;
export const SNAPSHOT_HZ = 20;
export const INPUT_HZ = 30;

/** Snapshots older than this are dropped from the interpolation buffer. */
export const INTERP_DELAY_MS = 110;

/** No word from a peer for this long and the server drops them. */
export const HEARTBEAT_MS = 25000;
export const DEAD_MS = 60000;

/** A human's draft pick auto-places after this, so one person answering the
 *  door cannot hold three other people hostage. Single player never times out
 *  (`flowDraft.js` says so in as many words); an online draft has to. */
export const DRAFT_PICK_SEC = 30;

/** How long a disconnected player's seat is held before a bot takes over. */
export const RECONNECT_GRACE_SEC = 45;

/* ================================================================== requests
   Client -> server. Every one of these gets exactly one reply. */
export const REQ = {
  /* --- session -------------------------------------------------------
     ONE CALL. `hello` carries the device id and the name the player typed
     on their own machine, and that IS the session — there is no account to
     register, no password to get wrong and no token to expire. Send it again
     with the same device id after a reload and you are back in your room, and
     back behind your settler if the match is still running. */
  HELLO: 'hello',            // { version, device, name } -> { version, you }
  SET_NAME: 'name.set',      // { name } -> { you }

  /* --- rooms ---------------------------------------------------------
     A room is a five-character code, and the code is the whole permission
     model: whoever types it while the lobby is open is in. */
  ROOM_CREATE: 'room.create',      // {} -> { room }
  ROOM_JOIN: 'room.join',          // { code } -> { room }
  ROOM_LEAVE: 'room.leave',        // {} -> {}
  ROOM_KICK: 'room.kick',          // { userId } -> {}   (host only)
  ROOM_SETTINGS: 'room.settings',  // { difficulty, knights } -> { room }  (host only)
  ROOM_READY: 'room.ready',        // { ready } -> {}
  ROOM_START: 'room.start',        // {} -> {}   — the same vote as ROOM_READY

  /* --- match --------------------------------------------------------- */
  MATCH_INPUT: 'm.in',             // { dx, dz, seq }        — fire and forget
  MATCH_ACT: 'm.act',              // { kind, ...args } -> { ok } | err
  MATCH_LEAVE: 'm.leave',          // {} -> {}

  PING: 'ping'                     // { c } -> { c }   round-trip probe
};

/* ================================================================== pushes
   Server -> client, unsolicited. */
export const PUSH = {
  ROOM: 'room',              // { room } | { room: null } when you have left
  KICKED: 'kicked',          // { reason }

  MATCH_BEGIN: 'm.begin',    // { matchId, seed, seats, yourPid, difficulty, knights }
  MATCH_DRAFT: 'm.draft',    // { index, pid, need, anchor, deadline, order }
  MATCH_GO: 'm.go',          // { at }  — the countdown is armed, play starts
  MATCH_SNAP: 'm.snap',      // see SNAP below
  MATCH_EV: 'm.ev',          // { evs: [ ...rules events... ] }
  MATCH_OVER: 'm.over',      // { winner, reason }
  MATCH_END: 'm.end',        // { reason } — the match is torn down
  MATCH_PEER: 'm.peer',      // { pid, state: 'live'|'gone'|'bot' }

  ERROR: 'error'             // { code, message } — connection-level
};

/** Reply envelopes. */
export const OK = 'ok';
export const ERR = 'err';

/* =================================================================== errors
   Codes are stable strings, not numbers: a log line that says
   'name.taken' needs no lookup table and no comment. */
export const E = {
  VERSION: 'version.mismatch',
  BAD_REQUEST: 'bad.request',
  UNAUTHED: 'hello.required',
  NAME_BAD: 'name.bad',
  CODE_BAD: 'code.bad',
  RATE: 'rate.limited',
  NO_ROOM: 'room.unknown',
  ROOM_FULL: 'room.full',
  ROOM_BUSY: 'room.playing',
  NOT_HOST: 'room.nothost',
  NO_MATCH: 'match.none',
  ILLEGAL: 'move.illegal',
  NOT_YOUR_TURN: 'move.notyours',
  INTERNAL: 'internal'
};

/** Plain-language for every code above. The client shows these verbatim, so
 *  they are written as something a person would say, not as a log line. */
export const E_TEXT = {
  [E.VERSION]: 'This page is out of date — reload to get the new version.',
  [E.BAD_REQUEST]: 'That request did not make sense.',
  [E.UNAUTHED]: 'Not connected yet — one moment.',
  [E.NAME_BAD]: 'Names are 2 to 14 letters, numbers, spaces, dots, dashes or underscores.',
  [E.CODE_BAD]: 'A room code is five letters and numbers.',
  [E.RATE]: 'Too many tries — wait a moment.',
  [E.NO_ROOM]: 'No room with that code. Check it and try again.',
  [E.ROOM_FULL]: 'That room is full — it seats four.',
  [E.ROOM_BUSY]: 'That match has already started.',
  [E.NOT_HOST]: 'Only the player who made the room can do that.',
  [E.NO_MATCH]: 'You are not in a match.',
  [E.ILLEGAL]: 'You cannot do that there.',
  [E.NOT_YOUR_TURN]: 'Not your turn yet.',
  [E.INTERNAL]: 'Something went wrong on the server.'
};

export function errText(code) {
  return E_TEXT[code] || 'Something went wrong.';
}

/* =================================================================== limits */
export const NAME_MIN = 2;
export const NAME_MAX = 14;
export const SEATS = 4;

const NAME_RE = /^[A-Za-z0-9 ._-]+$/;

/** The one place a name is judged. Both ends call it, so the browser can grey
 *  out the button for the same reason the server would refuse.
 *
 *  Names are NOT unique any more and are not checked against anything: there
 *  are no accounts, a name is a label on a seat, and two friends called Sam in
 *  one room is their problem and not the server's. */
export function nameProblem(name) {
  const n = String(name == null ? '' : name).trim();
  if (n.length < NAME_MIN || n.length > NAME_MAX) return E.NAME_BAD;
  if (!NAME_RE.test(n)) return E.NAME_BAD;
  return null;
}

/** Trimmed, collapsed, capped — what actually gets stored and shown. */
export function cleanName(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
}

/* ================================================================ room codes
 *
 *   "I'd rather just switch to a create a room and use a room code... whoever
 *    put in that room code while the lobby was open is added to the game.
 *    Finally, for the game room, it should only be 5 characters long."
 *
 * Five characters out of a 32-letter alphabet is 33.5 million rooms, which is
 * far more than a game with a handful of lobbies at a time will ever need — the
 * length is chosen for the person reading it down a phone line, not for the
 * key space.
 *
 * I, L, O, 0 and 1 are not in the alphabet, because a code is something one
 * friend reads out and another types, and "is that an oh or a zero" is the
 * failure this costs five letters to make impossible. They are never generated,
 * so they can only ever arrive as a typo.
 *
 * Both ends normalise the same way: uppercase, and throw away anything that is
 * not a letter or a digit — so spaces, dashes and a pasted "code: ABCDE" all
 * work without the player having to know they were tidied up.
 */
export const CODE_LEN = 5;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function cleanCode(code) {
  return String(code == null ? '' : code)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LEN);
}

export function codeProblem(code) {
  const c = cleanCode(code);
  if (c.length !== CODE_LEN) return E.CODE_BAD;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return E.CODE_BAD;
  return null;
}

/* ================================================================ match acts
   What a client is allowed to ask the match to do. Everything here is a
   REQUEST — it gets an ok or an err — because "the server refused your road"
   is information the player needs, not something to swallow. */
export const ACT = {
  DRAFT_SETTLEMENT: 'draft.settlement', // { id }
  DRAFT_ROAD: 'draft.road',             // { id }
  BUILD_ROAD: 'build.road',             // { id }
  BUILD_SETTLEMENT: 'build.settlement', // { id }
  BUILD_CITY: 'build.city',             // { id }
  BUY_CARD: 'buy.card',                 // {}
  PLAY_KNIGHT: 'play.knight',           // { tile }
  PLAY_ROADS: 'play.roads',             // {}
  FREE_ROAD: 'free.road',               // { id }  — spending a Road Building road
  TRADE: 'trade'                        // { give, get, ratio, port }
};

/* ================================================================= snapshot
   Positions and the running totals that change every frame.

   Deliberately an ARRAY OF NUMBERS, not an array of objects. At 20Hz for the
   length of a match this is the single biggest thing on the wire, and
   `{"x":12.3,"z":-4.5,...}` spends more bytes on the same six key names ten
   thousand times than it does on the numbers. Fixed offsets, one comment.

   Per seat: [ x, z, facing, action, wood, brick, wool, wheat, ore ]
   `action` is an index into ACTIONS below rather than the string. */
export const SNAP_STRIDE = 9;
export const ACTIONS = ['idle', 'run', 'gather', 'build', 'trade', 'celebrate'];

export function actionIndex(name) {
  const i = ACTIONS.indexOf(name);
  return i < 0 ? 0 : i;
}

export function actionName(i) {
  return ACTIONS[i] || 'idle';
}

/** Positions are sent to a tenth of a world unit. A settler is 2 units tall
 *  and moves 12 units a second, so a tenth is a twelfth of a frame of travel —
 *  invisible, and it halves the digits of every number in the snapshot. */
export const POS_Q = 10;
const q = v => Math.round((Number.isFinite(v) ? v : 0) * POS_Q) / POS_Q;

/** Pack the four seats of a live match into the flat array above. */
export function packSeats(players) {
  const out = new Array(players.length * SNAP_STRIDE);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const o = i * SNAP_STRIDE;
    out[o] = q(p.x);
    out[o + 1] = q(p.z);
    out[o + 2] = q(p.facing);
    out[o + 3] = actionIndex(p.action);
    out[o + 4] = p.res.wood | 0;
    out[o + 5] = p.res.brick | 0;
    out[o + 6] = p.res.wool | 0;
    out[o + 7] = p.res.wheat | 0;
    out[o + 8] = p.res.ore | 0;
  }
  return out;
}

/** Read one seat back out. Returns null for a short or absent array rather
 *  than throwing: a truncated snapshot should drop a frame, not the match. */
export function readSeat(arr, pid) {
  if (!Array.isArray(arr)) return null;
  const o = pid * SNAP_STRIDE;
  if (o + SNAP_STRIDE > arr.length) return null;
  return {
    x: arr[o], z: arr[o + 1], facing: arr[o + 2],
    action: actionName(arr[o + 3]),
    res: {
      wood: arr[o + 4], brick: arr[o + 5], wool: arr[o + 6],
      wheat: arr[o + 7], ore: arr[o + 8]
    }
  };
}

/* ============================================================ input framing
   The stick is sent in WORLD SPACE, already turned by the sender's camera.

   `playerController.readStick` rotates the raw stick by the camera yaw, and
   the camera is a client-side thing that the server has no business knowing
   about — two players looking different ways would need two server cameras to
   interpret the same stick. So the client does its own rotation and sends
   where it wants to GO. The server hands that straight to a controller with a
   yaw of zero, which is the identity case of the same maths. */
export function packInput(dx, dz, seq) {
  return {
    t: REQ.MATCH_INPUT,
    x: Math.round((Number.isFinite(dx) ? dx : 0) * 1000) / 1000,
    z: Math.round((Number.isFinite(dz) ? dz : 0) * 1000) / 1000,
    q: seq | 0
  };
}

/** A world-space direction becomes the stick a yaw-0 controller expects.
 *  With yaw = 0, readStick's basis is forward (0,-1) and right (1,0), so
 *  stick.x is the x we asked for and stick.y is the NEGATED z. */
export function inputToStick(x, z) {
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(z) ? -z : 0 };
}

/* ============================================================ public shapes
   Small builders so both ends agree on what a user or a seat looks like when
   it crosses the wire. Anything not listed here is not sent — password hashes
   and salts have no builder on purpose. */

export function publicUser(u, extra = {}) {
  if (!u) return null;
  return { id: u.id, name: u.name, ...extra };
}

/** Four random characters out of the readable alphabet, plus one more. Kept
 *  here rather than in the server so both ends agree on what a code looks
 *  like — the client validates a typed one against exactly this. */
export function makeCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return s;
}

export function publicSeat(seat) {
  return {
    pid: seat.pid,
    kind: seat.kind,                 // 'human' | 'bot' | 'empty'
    userId: seat.userId || null,
    name: seat.name,
    color: seat.color,               // the PLAYER_COLORS key
    state: seat.state || 'live'      // 'live' | 'gone' | 'bot'
  };
}

export default {
  PROTOCOL_VERSION, SIM_HZ, SNAPSHOT_HZ, INPUT_HZ, INTERP_DELAY_MS,
  HEARTBEAT_MS, DEAD_MS, DRAFT_PICK_SEC, RECONNECT_GRACE_SEC,
  REQ, PUSH, ACT, OK, ERR, E, E_TEXT, errText,
  NAME_MIN, NAME_MAX, SEATS, CODE_LEN, CODE_ALPHABET,
  nameProblem, cleanName, cleanCode, codeProblem, makeCode,
  SNAP_STRIDE, ACTIONS, actionIndex, actionName, POS_Q,
  packSeats, readSeat, packInput, inputToStick,
  publicUser, publicSeat
};
