/**
 * Island Settlers — the hub.
 *
 *   createHub({ players, rooms, matches }) -> { attach(peer), stats }
 *
 * Everything a connected client can do, and the only file that knows a socket
 * and a game exist at the same time. Identity lives in players.mjs, lobbies in
 * rooms.mjs, the simulation in a worker; this routes between them and decides
 * who is allowed to ask for what.
 *
 * ONE CALL TO GET IN
 * ------------------
 * A peer arrives anonymous and may only call `hello` and `ping`; everything
 * else answers `hello.required`. `hello` carries a device id and a name and
 * that is the whole of it — there is no account, no password and no token. The
 * accounts this replaced are described in players.mjs; the short version is
 * that they were an obstacle between four friends and a game, and every one of
 * their failure modes was silent.
 *
 * Two sockets claiming the same device: the older one is closed rather than
 * shadowed, because two live sockets for one player means a seat in a match has
 * two possible answers. The old tab is told why.
 *
 * THE RATE LIMIT IS ON THE DOOR
 * -----------------------------
 * Movement and match actions arrive up to thirty times a second by design, and
 * a limiter on those is a limiter on playing the game. What needs one is the
 * one call whose cost per try is a single frame and whose reward is somebody
 * else's lobby: joining by code. Counted per IP.
 *
 * Owner: net agent.
 */

import {
  PROTOCOL_VERSION, REQ, PUSH, OK, ERR, E,
  publicUser, nameProblem, cleanName, codeProblem
} from '../src/net/protocol.js';

/** Room-code guesses allowed per IP per window. Five characters out of a
 *  31-letter alphabet is 28.6 million codes; at this rate a determined guesser
 *  needs about four thousand years per open lobby. */
const JOIN_TRIES = 20;
const JOIN_WINDOW_MS = 60000;
/** Anything at all, per connection, per second. A generous ceiling that only
 *  a broken or malicious client will ever touch. */
const MSG_PER_SEC = 120;

export function createHub(deps) {
  const { players, rooms, matches } = deps;

  const live = new Map();       // userId -> peer
  const byPeer = new Set();     // every attached peer, greeted or not
  const joinHits = new Map();   // ip -> { n, until }

  /* ---------------------------------------------------------------- send */

  function toUser(userId, msg) {
    const peer = live.get(userId);
    if (peer) peer.send(msg);
    return !!peer;
  }

  function pushRoom(room) {
    if (!room) return;
    const payload = { t: PUSH.ROOM, room: rooms.publicRoom(room) };
    for (const uid of rooms.members(room)) toUser(uid, payload);
  }

  /* ------------------------------------------------------------ requests */

  function reply(peer, i, body) {
    if (i === undefined || i === null) return;
    peer.send({ i, t: OK, ...body });
  }

  function fail(peer, i, code, extra) {
    if (i === undefined || i === null) return;
    peer.send({ i, t: ERR, code, ...(extra || {}) });
  }

  function joinRateOk(ip) {
    const now = Date.now();
    let hit = joinHits.get(ip);
    if (!hit || now > hit.until) { hit = { n: 0, until: now + JOIN_WINDOW_MS }; joinHits.set(ip, hit); }
    hit.n++;
    return hit.n <= JOIN_TRIES;
  }

  /**
   * `hello` is the whole session. Same device id, same player, same seat.
   *
   * Everything after the identity lookup is what `signIn` used to do: claim the
   * socket, hand back the room you were in, and put you behind your settler if
   * the match you were in is still running. That last one is the reason the
   * reload between the lobby and the first frame of the match is survivable.
   */
  function greet(peer, msg, i) {
    if (msg.version !== PROTOCOL_VERSION) {
      return fail(peer, i, E.VERSION, { server: PROTOCOL_VERSION });
    }
    const r = players.session(msg.device, msg.name);
    if (r.error) return fail(peer, i, r.error);
    const me = r.player;

    // One socket per device. The old tab is told why rather than just going
    // quiet, so somebody who opened the game twice understands what happened.
    const old = live.get(me.id);
    if (old && old !== peer) {
      old.send({ t: PUSH.KICKED, reason: 'opened-elsewhere' });
      old.data.userId = null;
      old.close(1000, 'opened elsewhere');
    }
    peer.data.userId = me.id;
    live.set(me.id, peer);

    reply(peer, i, {
      version: PROTOCOL_VERSION,
      you: publicUser(me),
      device: me.device,
      players: players.count,
      rooms: rooms.size
    });

    const room = rooms.forUser(me.id);
    if (room) {
      // The name may have changed since the seat was taken.
      const seat = rooms.seatOf(room, me.id);
      if (seat && seat.name !== me.name) { seat.name = me.name; }
      peer.send({ t: PUSH.ROOM, room: rooms.publicRoom(room) });
      pushRoom(room);
      // Somebody who reloaded mid-match gets their settler back rather than a
      // lobby. Their seat was held, not vacated — see detach().
      if (room.state === 'playing') resumeSeat(me.id);
    }
  }

  function handle(peer, msg) {
    const i = msg.i;
    const t = msg.t;

    /* --- open to anyone -------------------------------------------- */
    if (t === REQ.HELLO) return greet(peer, msg, i);
    if (t === REQ.PING) return reply(peer, i, { c: msg.c });

    /* --- everything below needs a session -------------------------- */
    const me = players.byId(peer.data.userId);
    if (!me) return fail(peer, i, E.UNAUTHED);
    players.touch(me.id);

    switch (t) {
      /* --------------------------------------------------------- name */
      case REQ.SET_NAME: {
        const r = players.rename(me.id, msg.name);
        if (r.error) return fail(peer, i, r.error);
        const room = rooms.forUser(me.id);
        const seat = room && rooms.seatOf(room, me.id);
        if (seat) { seat.name = r.player.name; pushRoom(room); }
        return reply(peer, i, { you: publicUser(r.player) });
      }

      /* -------------------------------------------------------- rooms */
      case REQ.ROOM_CREATE: {
        const existing = rooms.forUser(me.id);
        if (existing && existing.state === 'playing') return fail(peer, i, E.ROOM_BUSY);
        if (existing) leaveRoom(me.id);
        const room = rooms.create(me);
        pushRoom(room);
        return reply(peer, i, { room: rooms.publicRoom(room) });
      }

      /* THE CODE IS THE PERMISSION.
       *
       *   "Just say whoever put in that room code while the lobby was open is
       *    added to the game."
       *
       * Two questions and no third: does this code name a room, and is that
       * room still in the lobby. There is nothing to be invited to and nobody
       * to accept you. */
      case REQ.ROOM_JOIN: {
        const bad = codeProblem(msg.code);
        if (bad) return fail(peer, i, bad);
        const room = rooms.get(msg.code);
        // Rate-limited on the MISS, not the hit: somebody typing their friend's
        // code wrong twice is not an attacker, and somebody walking the code
        // space never gets a hit to spend their budget on.
        if (!room) {
          if (!joinRateOk(peer.remote)) return fail(peer, i, E.RATE);
          return fail(peer, i, E.NO_ROOM);
        }
        if (room.state === 'playing') {
          // Unless it is the room you are already in — a reload mid-match must
          // not be told the door is shut on its own match.
          if (!rooms.seatOf(room, me.id)) return fail(peer, i, E.ROOM_BUSY);
        }
        const r = rooms.join(room, me);
        if (r.error) return fail(peer, i, r.error === 'room.full' ? E.ROOM_FULL : E.NO_ROOM);
        pushRoom(room);
        return reply(peer, i, { room: rooms.publicRoom(room) });
      }

      case REQ.ROOM_LEAVE: {
        leaveRoom(me.id);
        peer.send({ t: PUSH.ROOM, room: null });
        return reply(peer, i, {});
      }

      case REQ.ROOM_KICK: {
        const room = rooms.forUser(me.id);
        if (!room) return fail(peer, i, E.NO_ROOM);
        if (room.hostId !== me.id) return fail(peer, i, E.NOT_HOST);
        const targetId = String(msg.userId || '');
        if (targetId === me.id) return fail(peer, i, E.BAD_REQUEST);
        leaveRoom(targetId);
        toUser(targetId, { t: PUSH.ROOM, room: null });
        toUser(targetId, { t: PUSH.KICKED, reason: 'removed-from-lobby' });
        return reply(peer, i, {});
      }

      case REQ.ROOM_SETTINGS: {
        const room = rooms.forUser(me.id);
        if (!room) return fail(peer, i, E.NO_ROOM);
        if (room.hostId !== me.id) return fail(peer, i, E.NOT_HOST);
        if (room.state === 'playing') return fail(peer, i, E.ROOM_BUSY);
        rooms.setSettings(room, msg);
        pushRoom(room);
        return reply(peer, i, { room: rooms.publicRoom(room) });
      }

      /* START IS A VOTE, NOT A COMMAND.
       *
       *   "Make sure that both players have to start the game for it to
       *    actually start. If one person presses start, then it shows as
       *    waiting for the other player."
       *
       * Both requests do the same thing, because they are the same thing: mark
       * this seat ready, tell the table, and begin the moment the last human
       * has said yes. There is no host override — a lobby of one human and
       * three bots starts on that one press, which is not a special case, it is
       * the same rule with nobody left to wait for.
       */
      case REQ.ROOM_READY:
      case REQ.ROOM_START: {
        const room = rooms.forUser(me.id);
        if (!room) return fail(peer, i, E.NO_ROOM);
        if (room.state === 'playing') return fail(peer, i, E.ROOM_BUSY);
        // ROOM_START always means yes; ROOM_READY carries the flag, so the
        // same button can take it back.
        const want = t === REQ.ROOM_START ? true : !!msg.ready;
        if (!rooms.setReady(room, me.id, want)) return fail(peer, i, E.NO_ROOM);
        // Read the roster BEFORE trying to start: beginMatch clears every
        // ready flag on its way out, so asking afterwards reports that the
        // whole table is waiting for itself.
        const waitingFor = rooms.humans(room).filter(s => !s.ready).map(s => s.name);
        const began = maybeStart(room);
        if (began && began.error) {
          // Could not start after all — un-ready everyone rather than leave a
          // lobby that looks like it is about to go and never does.
          rooms.clearReady(room);
          pushRoom(room);
          return fail(peer, i, began.error);
        }
        if (!began) pushRoom(room);
        return reply(peer, i, {
          ready: want,
          waitingFor,
          started: !!(began && began.matchId)
        });
      }

      /* -------------------------------------------------------- match */
      case REQ.MATCH_INPUT: {
        const seat = matchSeat(me.id);
        if (!seat) return;                    // fire and forget: never replies
        matches.input(seat.matchId, seat.pid, msg.x, msg.z);
        return;
      }

      case REQ.MATCH_ACT: {
        const seat = matchSeat(me.id);
        if (!seat) return fail(peer, i, E.NO_MATCH);
        // The reply comes back from the worker, asynchronously; remember who
        // asked so the worker's answer can find its way home.
        pending.set(`${seat.matchId}:${seat.pid}:${i}`, { userId: me.id, i });
        matches.act(seat.matchId, seat.pid, i, msg);
        return;
      }

      case REQ.MATCH_LEAVE: {
        const seat = matchSeat(me.id);
        if (seat) matches.peer(seat.matchId, seat.pid, 'left');
        leaveRoom(me.id);
        peer.send({ t: PUSH.ROOM, room: null });
        return reply(peer, i, {});
      }

      default:
        return fail(peer, i, E.BAD_REQUEST);
    }
  }

  /* ------------------------------------------------------------- matches */

  const pending = new Map();     // "matchId:pid:i" -> { userId, i }
  const matchOf = new Map();     // matchId -> { roomId, seats: [roster], byUser: Map }

  function matchSeat(userId) {
    const room = rooms.forUser(userId);
    if (!room || room.state !== 'playing' || !room.matchId) return null;
    const info = matchOf.get(room.matchId);
    if (!info) return null;
    const pid = info.byUser.get(userId);
    return pid === undefined ? null : { matchId: room.matchId, pid, room };
  }

  /**
   * Begin, if and only if every human in the room has said yes.
   *
   * Returns null when there is still somebody to wait for — which is the
   * normal outcome and not a failure — the start result otherwise.
   */
  function maybeStart(room) {
    if (!room || room.state === 'playing') return null;
    if (!rooms.allReady(room)) return null;
    return startMatch(room);
  }

  function startMatch(room) {
    const roster = rooms.roster(room);
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const started = matches.start({
      seed,
      roster,
      roomId: room.id,
      difficulty: room.settings.difficulty,
      knights: room.settings.knights
    });
    if (started.error) {
      return { error: started.error === 'busy' ? E.RATE : E.INTERNAL };
    }
    const byUser = new Map();
    for (const s of roster) if (s.userId) byUser.set(s.userId, s.pid);
    matchOf.set(started.matchId, {
      roomId: room.id, roster, byUser, seed,
      difficulty: room.settings.difficulty,
      knights: room.settings.knights,
      // The host's answer for the whole table — see rooms.setSettings.
      autoDraft: !!room.settings.autoDraft,
      order: null                        // filled in by the worker's `begin`
    });
    rooms.beginMatch(room, started.matchId);
    pushRoom(room);
    return { matchId: started.matchId };
  }

  /** Everything the worker says, routed to whoever needs to hear it. */
  function fromMatch(matchId, msg) {
    const info = matchOf.get(matchId);
    if (!info) return;

    if (msg.t === 'actres') {
      const key = `${matchId}:${msg.pid}:${msg.i}`;
      const who = pending.get(key);
      pending.delete(key);
      if (!who) return;
      const peer = live.get(who.userId);
      if (!peer) return;
      if (msg.ok) peer.send({ i: who.i, t: OK });
      else peer.send({ i: who.i, t: ERR, code: msg.code || E.ILLEGAL });
      return;
    }

    if (msg.t === 'begin') {
      // Remembered so a reconnect can be told the SAME thing — see resumeSeat.
      info.order = msg.order;
      if (msg.difficulty) info.difficulty = msg.difficulty;
      if (typeof msg.knights === 'boolean') info.knights = msg.knights;
      // Each client is told which seat is theirs; everything else is the same
      // message for everyone, which is what makes it one broadcast.
      for (const [userId, pid] of info.byUser) {
        toUser(userId, {
          t: PUSH.MATCH_BEGIN,
          matchId,
          seed: msg.seed,
          seats: msg.roster,
          order: msg.order,
          yourPid: pid,
          difficulty: msg.difficulty,
          knights: msg.knights,
          autoDraft: !!info.autoDraft
        });
      }
      return;
    }

    const map = {
      draft: PUSH.MATCH_DRAFT,
      go: PUSH.MATCH_GO,
      snap: PUSH.MATCH_SNAP,
      ev: PUSH.MATCH_EV,
      over: PUSH.MATCH_OVER,
      free: 'm.free',
      peerok: PUSH.MATCH_PEER
    };
    const type = map[msg.t];
    if (!type) return;

    if (msg.t === 'over') {
      const room = rooms.get(info.roomId);
      broadcast(info, { ...msg, t: type });
      if (room) {
        rooms.endMatch(room);
        pushRoom(room);
      }
      return;
    }
    broadcast(info, { ...msg, t: type });
  }

  function broadcast(info, msg) {
    for (const userId of info.byUser.keys()) toUser(userId, msg);
  }

  function matchGone(matchId, reason) {
    const info = matchOf.get(matchId);
    matchOf.delete(matchId);
    if (!info) return;
    for (const key of [...pending.keys()]) {
      if (key.startsWith(`${matchId}:`)) pending.delete(key);
    }
    broadcast(info, { t: PUSH.MATCH_END, reason });
    const room = rooms.get(info.roomId);
    if (room && room.state === 'playing') {
      rooms.endMatch(room);
      pushRoom(room);
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  function leaveRoom(userId) {
    const room = rooms.forUser(userId);
    if (!room) return;
    /* Keep the match id before `rooms.leave` potentially dissolves the room.
       A room with no humans has nobody who can reconnect to it and nobody who
       can receive its snapshots, so its worker must be reclaimed immediately.
       `matchhost` has always supported the "everybody leaves" ending; this is
       the missing wire that actually invokes it. Without it, six abandoned
       games occupy all six worker slots until bots finish on their own, and a
       real new room is refused as `rate.limited`. */
    const playingMatchId = room.state === 'playing' ? room.matchId : null;
    /*
     * Walking out of a lobby mid-match hands your settler to a bot rather
     * than deleting it: the island already has your roads on it.
     *
     * The state sent is 'left', not 'bot', and the difference matters at the
     * far end:
     *
     *   "When one player left, the other player didn't see a popup showing
     *    them that their friend left, it just crossed out the friend's AND the
     *    other bots' names in the top right corner even though the bots were
     *    still playing."
     *
     * The seats that were bots from the opening whistle are also 'bot', so a
     * standings row that greys itself out on 'bot' greys out three of the four
     * seats the moment anybody walks. 'left' means A PERSON WHO WAS HERE AND
     * ISN'T — exactly the row worth striking through, and the only one worth a
     * popup. The worker plays a 'left' seat identically to a 'bot' one.
     */
    if (room.state === 'playing' && room.matchId) {
      const info = matchOf.get(room.matchId);
      const pid = info && info.byUser.get(userId);
      if (pid !== undefined) matches.peer(room.matchId, pid, 'left');
    }
    const r = rooms.leave(userId);
    if (r && r.dissolved && playingMatchId) {
      matches.stop(playingMatchId, 'abandoned');
    } else if (r && !r.dissolved) {
      // The people still in the lobby may all have been ready already, waiting
      // on the person who just walked out. Do not strand them.
      if (!maybeStart(r.room)) pushRoom(r.room);
    }
  }

  function detach(peer, why) {
    const userId = peer.data.userId;
    if (!userId) return;
    if (live.get(userId) === peer) live.delete(userId);
    peer.data.userId = null;

    // A dropped connection does NOT leave the lobby. Reloading a page, losing
    // a tunnel for four seconds or a phone changing network are all the same
    // event to a socket, and none of them should cost somebody their seat.
    const room = rooms.forUser(userId);
    if (room && room.state === 'playing' && room.matchId) {
      const info = matchOf.get(room.matchId);
      const pid = info && info.byUser.get(userId);
      if (pid !== undefined) matches.peer(room.matchId, pid, 'gone');
    }
    if (room) pushRoom(room);
  }

  /* When a dropped player comes back and their seat is still theirs, put them
     back behind it. `greet` re-sends the room; this puts the settler back
     under their control and tells the table.
   *
   * THIS MESSAGE MUST CARRY EVERYTHING THE FIRST ONE DID. It used to send the
   * seed, the roster and the seat and stop there — no draft order, no
   * difficulty, no knights flag. The client parks it and reloads, and on the
   * way back up `mirror.js` skips the order (so it keeps its own locally
   * generated one) and `main.js` reads `knights !== false` off a field that
   * was not there and forces Knights ON. A reconnecting player therefore came
   * back into a subtly different match from the one everyone else was in. */
  function resumeSeat(userId) {
    const seat = matchSeat(userId);
    if (!seat) return;
    matches.peer(seat.matchId, seat.pid, 'live');
    const info = matchOf.get(seat.matchId);
    if (info) {
      toUser(userId, {
        t: PUSH.MATCH_BEGIN,
        matchId: seat.matchId,
        seed: info.seed,
        seats: info.roster,
        order: info.order,
        difficulty: info.difficulty,
        knights: info.knights,
        autoDraft: !!info.autoDraft,
        yourPid: seat.pid,
        resumed: true
      });
    }
  }

  function attach(peer) {
    byPeer.add(peer);
    let budget = MSG_PER_SEC;
    const refill = setInterval(() => { budget = MSG_PER_SEC; }, 1000);
    refill.unref?.();

    peer.onMessage = msg => {
      if (budget-- <= 0) return;
      if (typeof msg.t !== 'string') return;
      try {
        handle(peer, msg);
      } catch (e) {
        console.error('[hub] handler blew up on', msg.t, e && e.stack);
        if (msg.i !== undefined) fail(peer, msg.i, E.INTERNAL);
      }
    };
    peer.onClose = () => {
      clearInterval(refill);
      byPeer.delete(peer);
      detach(peer, 'closed');
    };
  }

  return {
    attach,
    fromMatch,
    matchGone,
    resumeSeat,
    get stats() {
      return {
        sockets: byPeer.size,
        online: live.size,
        rooms: rooms.size,
        matches: matches.size,
        players: players.count
      };
    }
  };
}

export default createHub;
