/**
 * Island Settlers — lobbies.
 *
 *   createRooms() -> { create, get, forUser, join, leave, ... }
 *
 * A room is a five-character CODE, four seats, a host, two settings and a
 * state. It exists from the moment somebody presses CREATE A ROOM until the
 * last person leaves.
 *
 * THE CODE IS THE PERMISSION
 * --------------------------
 *   "I'd rather just switch to a create a room and use a room code, since it's
 *    not just 1 on 1 and sometimes there's 3 or even four friends playing
 *    together. Remove adding friends, remove accepting players, just say
 *    whoever put in that room code while the lobby was open is added."
 *
 * There is no invite list and nothing to accept. `join` asks two questions —
 * does this code name a room, and is that room still in the lobby — and the
 * answer to both being yes is the whole of the access control. Which is the
 * right model for four friends in a group chat, and it is also what makes it
 * impossible to end up in the situation the old friends screen made easy:
 * everybody typing the same five characters is, unambiguously, one room.
 *
 * SEATS ARE STABLE, MEMBERSHIP IS NOT
 * -----------------------------------
 * A seat index is a player id in `core/rules.js` and a colour in
 * `PLAYER_COLORS`, and both of those are baked into the match the instant it
 * starts. So joining takes the lowest free seat and KEEPS it: leaving and
 * rejoining the lobby gets you the same seat if it is still free, which means
 * the orange settler stays orange while people mill about before the draft.
 *
 * EMPTY SEATS ARE BOTS, DECIDED AT START
 * --------------------------------------
 *   "Fill with bots at your chosen difficulty."
 *
 * Nothing is decided about a bot until START is pressed — an empty seat in the
 * lobby is shown as open, because somebody might still walk into it. The
 * moment the host starts, every seat that is still empty becomes a bot at the
 * room's difficulty, and the roster the match is built from is frozen.
 *
 * A ROOM IS NOT A MATCH
 * ---------------------
 * The room survives the match. When the match ends everyone lands back in the
 * same lobby with the same seats and can start another one, which is the
 * multiplayer version of Play Again.
 *
 * Owner: net agent.
 */

import { randomInt } from 'node:crypto';
import { SEATS, CODE_LEN, CODE_ALPHABET, cleanCode } from '../src/net/protocol.js';

/** The four colours, in the order `core/constants.js` declares them. Kept as
 *  plain strings here so the server never imports the game's constants for a
 *  label — the client resolves the real colour from its own PLAYER_COLORS. */
const COLORS = ['blue', 'red', 'orange', 'purple'];

/** An abandoned lobby is swept after this. Somebody who opens the screen and
 *  wanders off should not leave a room in the list forever. */
const IDLE_SWEEP_MS = 2 * 3600 * 1000;

export function createRooms() {
  const rooms = new Map();      // roomId -> room
  const userRoom = new Map();   // userId -> roomId

  /**
   * Five characters, and the code IS the door.
   *
   *   "Just say whoever put in that room code while the lobby was open is added
   *    to the game. For the game room, it should only be 5 characters long."
   *
   * `randomInt` rather than `Math.random` because this is now the only thing
   * standing between a stranger and somebody's game: 33.5 million codes is
   * plenty of room to guess into, but only if the codes are not predictable
   * from each other. The alphabet has no I, L, O, 0 or 1 in it — see the note
   * in protocol.js about reading a code down a phone line.
   */
  function newCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return s;
  }

  function create(host) {
    leave(host.id);
    let id = newCode();
    while (rooms.has(id)) id = newCode();
    const room = {
      id,
      hostId: host.id,
      createdAt: Date.now(),
      touchedAt: Date.now(),
      state: 'lobby',           // 'lobby' | 'playing'
      matchId: null,
      settings: { difficulty: 'medium', knights: true },
      seats: Array.from({ length: SEATS }, (_, pid) => ({
        pid,
        kind: 'empty',          // 'human' | 'bot' | 'empty'
        userId: null,
        name: '',
        color: COLORS[pid],
        ready: false,
        state: 'live'           // 'live' | 'gone' | 'bot'
      }))
    };
    rooms.set(id, room);
    sit(room, host);
    return room;
  }

  /** Codes are normalised the same way the client normalises them, so a code
   *  pasted with a space or typed in lower case still opens the door. */
  function get(code) {
    return rooms.get(cleanCode(code)) || null;
  }

  function forUser(userId) {
    const id = userRoom.get(userId);
    return id ? rooms.get(id) || null : null;
  }

  function seatOf(room, userId) {
    return room.seats.find(s => s.userId === userId) || null;
  }

  function sit(room, user) {
    const already = seatOf(room, user.id);
    if (already) {
      already.kind = 'human';
      already.state = 'live';
      already.name = user.name;
      userRoom.set(user.id, room.id);
      return already;
    }
    const free = room.seats.find(s => s.kind === 'empty');
    if (!free) return null;
    free.kind = 'human';
    free.userId = user.id;
    free.name = user.name;
    free.ready = false;
    free.state = 'live';
    userRoom.set(user.id, room.id);
    room.touchedAt = Date.now();
    return free;
  }

  function join(room, user) {
    if (!room) return { error: 'room.unknown' };
    if (room.state === 'playing') return { error: 'room.playing' };
    const mine = forUser(user.id);
    if (mine && mine.id !== room.id) leave(user.id);
    const seat = sit(room, user);
    if (!seat) return { error: 'room.full' };
    return { room, seat };
  }

  /**
   * Leave, and dissolve or re-host as needed.
   *
   * The host leaving does not kill the lobby: it hands the room to whoever has
   * been there longest, because ending everyone else's evening because one
   * person's browser crashed is a bad rule. It only disappears when the last
   * human walks out.
   */
  function leave(userId) {
    const room = forUser(userId);
    if (!room) return null;
    userRoom.delete(userId);
    const seat = seatOf(room, userId);
    if (seat) {
      seat.kind = 'empty';
      seat.userId = null;
      seat.name = '';
      seat.ready = false;
      seat.state = 'live';
    }
    room.touchedAt = Date.now();

    const left = room.seats.filter(s => s.kind === 'human');
    if (!left.length) {
      rooms.delete(room.id);
      return { room, dissolved: true };
    }
    if (room.hostId === userId) room.hostId = left[0].userId;
    return { room, dissolved: false };
  }

  function setSettings(room, patch) {
    if (!room || room.state === 'playing') return false;
    const before = `${room.settings.difficulty}/${room.settings.knights}`;
    if (typeof patch.difficulty === 'string') room.settings.difficulty = patch.difficulty;
    if (typeof patch.knights === 'boolean') room.settings.knights = patch.knights;
    // CHANGING THE GAME UNREADIES EVERYONE. You said yes to Medium with
    // Knights; the host quietly moving it to Expert should ask you again
    // rather than carry your agreement over to a different match.
    if (`${room.settings.difficulty}/${room.settings.knights}` !== before) clearReady(room);
    room.touchedAt = Date.now();
    return true;
  }

  function setReady(room, userId, ready) {
    const seat = room && seatOf(room, userId);
    if (!seat) return false;
    seat.ready = !!ready;
    room.touchedAt = Date.now();
    return true;
  }

  /* ------------------------------------------------------- everybody in
   *
   *   "Make sure that both players have to start the game for it to actually
   *    start. If one person presses start, then it shows as waiting for the
   *    other player."
   *
   * So START is not a host power any more, it is a vote, and the match begins
   * on the last vote rather than on anybody's say-so. A lobby of one human and
   * three bots therefore still starts the instant that one person presses it,
   * which is the same rule and not a special case: there is nobody else to
   * wait for.
   */
  function humans(room) {
    return room ? room.seats.filter(s => s.kind === 'human') : [];
  }

  function readyCount(room) {
    return humans(room).filter(s => s.ready).length;
  }

  function allReady(room) {
    const h = humans(room);
    return h.length > 0 && h.every(s => s.ready);
  }

  /** Nobody stays ready for a game other than the one they agreed to. */
  function clearReady(room) {
    if (!room) return;
    for (const s of room.seats) s.ready = false;
  }

  /**
   * Freeze the roster the match will be built from.
   *
   * Called once, by START. Every empty seat becomes a bot here and not a
   * moment earlier — see the note at the top about why the lobby keeps showing
   * them as open until the last second.
   */
  function roster(room) {
    return room.seats.map(s => ({
      pid: s.pid,
      kind: s.kind === 'human' ? 'human' : 'bot',
      userId: s.kind === 'human' ? s.userId : null,
      name: s.kind === 'human' ? s.name : botName(s.pid),
      color: s.color,
      state: s.kind === 'human' ? 'live' : 'bot'
    }));
  }

  /** The single-player rivals, by seat, so a mixed lobby reads the same way a
   *  solo match does. Seat 0 has no bot name in single player (it is "You"),
   *  so it borrows the first rival's. */
  const BOT_NAMES = ['Alex', 'Alex', 'Maya', 'Finn'];
  function botName(pid) {
    return BOT_NAMES[pid] || `Bot ${pid}`;
  }

  function beginMatch(room, matchId) {
    room.state = 'playing';
    room.matchId = matchId;
    room.touchedAt = Date.now();
    for (const s of room.seats) s.ready = false;
  }

  function endMatch(room) {
    if (!room) return;
    room.state = 'lobby';
    room.matchId = null;
    room.touchedAt = Date.now();
  }

  function members(room) {
    return room.seats.filter(s => s.kind === 'human').map(s => s.userId);
  }

  /** Everything the client needs to draw the lobby, and nothing else. */
  function publicRoom(room) {
    if (!room) return null;
    return {
      id: room.id,
      code: room.id,             // the id IS the code; named both ways so the
                                 // lobby can read `room.code` and mean it
      hostId: room.hostId,
      state: room.state,
      settings: { ...room.settings },
      seats: room.seats.map(s => ({
        pid: s.pid, kind: s.kind, userId: s.userId, name: s.name,
        color: s.color, ready: s.ready, state: s.state
      })),
      // So the lobby can say "1 of 2 ready" without counting seats itself,
      // and so it agrees with the server about when the match will begin.
      ready: readyCount(room),
      humans: humans(room).length
    };
  }

  function sweep() {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (room.state === 'playing') continue;
      if (now - room.touchedAt < IDLE_SWEEP_MS) continue;
      if (room.seats.some(s => s.kind === 'human')) continue;
      rooms.delete(id);
    }
  }

  return {
    create, get, forUser, join, leave, seatOf,
    setSettings, setReady, allReady, readyCount, clearReady, humans,
    roster, beginMatch, endMatch, members, publicRoom, sweep,
    get size() { return rooms.size; },
    all: () => [...rooms.values()]
  };
}

export default createRooms;
