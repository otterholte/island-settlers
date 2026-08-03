/**
 * Island Settlers — the hub.
 *
 *   createHub({ users, rooms, matches, secret }) -> { attach(peer), stats }
 *
 * Everything a connected client can do, and the only file that knows a socket
 * and a game exist at the same time. Accounts live in users.mjs, lobbies in
 * rooms.mjs, the simulation in a worker; this routes between them and decides
 * who is allowed to ask for what.
 *
 * ONE CONNECTION, ONE SESSION
 * ---------------------------
 * A peer arrives anonymous. It may only call `hello`, `register`, `login` and
 * `resume` until it has a user; everything else answers `auth.required`. Sign
 * in twice from two tabs and the older connection is closed rather than
 * shadowed, because two live sockets for one account means presence, invites
 * and a seat in a match all have two possible answers.
 *
 * PRESENCE IS DERIVED, NEVER STORED
 * ---------------------------------
 * "Online" is `live.has(userId)` — a fact about sockets, not a field in the
 * store. Nothing needs cleaning up after a crash, because a process that is
 * not running has no live sockets and therefore nobody is online. The store
 * only ever holds what should survive a restart.
 *
 * THE RATE LIMIT IS ON THE PASSWORD PATH ONLY
 * -------------------------------------------
 * Movement and match actions arrive up to thirty times a second by design, and
 * a limiter on those is a limiter on playing the game. What actually needs one
 * is the handful of calls where an attacker's cost per try is a single frame:
 * sign-in and sign-up. Those are counted per IP.
 *
 * Owner: net agent.
 */

import {
  PROTOCOL_VERSION, REQ, PUSH, OK, ERR, E,
  publicUser, nameProblem, passProblem
} from '../src/net/protocol.js';
import { makeToken, readToken } from './auth.mjs';

/** Sign-in attempts allowed per IP per window. */
const AUTH_TRIES = 12;
const AUTH_WINDOW_MS = 60000;
/** Anything at all, per connection, per second. A generous ceiling that only
 *  a broken or malicious client will ever touch. */
const MSG_PER_SEC = 120;

export function createHub(deps) {
  const { users, rooms, matches, secret } = deps;

  const live = new Map();       // userId -> peer
  const byPeer = new Set();     // every attached peer, authed or not
  const authHits = new Map();   // ip -> { n, until }

  /* ---------------------------------------------------------------- send */

  function toUser(userId, msg) {
    const peer = live.get(userId);
    if (peer) peer.send(msg);
    return !!peer;
  }

  function isOnline(id) { return live.has(id); }

  function inMatch(id) {
    const room = rooms.forUser(id);
    return !!(room && room.state === 'playing');
  }

  /** The friends payload. Sent on sign-in and re-sent, whole, on every change.
   *  A delta protocol for a list that is at most a couple of hundred entries
   *  and changes a few times an hour would be more code and more bugs than the
   *  bytes are worth. */
  function friendsPayload(id) {
    return {
      t: PUSH.FRIENDS,
      friends: users.friendIds(id).map(fid => {
        const u = users.byId(fid);
        return u ? publicUser(u, { online: isOnline(fid), inMatch: inMatch(fid) }) : null;
      }).filter(Boolean),
      incoming: users.incoming(id).map(r => {
        const u = users.byId(r.from);
        return u ? publicUser(u, { at: r.at }) : null;
      }).filter(Boolean),
      outgoing: users.outgoing(id).map(r => {
        const u = users.byId(r.id);
        return u ? publicUser(u, { at: r.at }) : null;
      }).filter(Boolean)
    };
  }

  function pushFriends(id) {
    if (!isOnline(id)) return;
    toUser(id, friendsPayload(id));
  }

  /** Tell this user's friends that something about them changed. */
  function pushPresence(id) {
    const payload = { t: PUSH.PRESENCE, userId: id, online: isOnline(id), inMatch: inMatch(id) };
    for (const fid of users.friendIds(id)) toUser(fid, payload);
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

  function rateOk(ip) {
    const now = Date.now();
    let hit = authHits.get(ip);
    if (!hit || now > hit.until) { hit = { n: 0, until: now + AUTH_WINDOW_MS }; authHits.set(ip, hit); }
    hit.n++;
    return hit.n <= AUTH_TRIES;
  }

  function signIn(peer, user) {
    // One socket per account. The old tab is told why rather than just going
    // quiet, so somebody who opened the game twice understands what happened.
    const old = live.get(user.id);
    if (old && old !== peer) {
      old.send({ t: PUSH.KICKED, reason: 'signed-in-elsewhere' });
      old.data.userId = null;
      old.close(1000, 'signed in elsewhere');
    }
    peer.data.userId = user.id;
    live.set(user.id, peer);
    users.touch(user.id);
    pushPresence(user.id);
    peer.send(friendsPayload(user.id));
    const room = rooms.forUser(user.id);
    if (room) peer.send({ t: PUSH.ROOM, room: rooms.publicRoom(room) });
    // Somebody who reloaded mid-match gets their settler back rather than a
    // lobby. Their seat was held, not vacated — see detach().
    if (room && room.state === 'playing') resumeSeat(user.id);
  }

  function handle(peer, msg) {
    const i = msg.i;
    const t = msg.t;

    /* --- open to anyone -------------------------------------------- */
    if (t === REQ.HELLO) {
      if (msg.version !== PROTOCOL_VERSION) {
        return fail(peer, i, E.VERSION, { server: PROTOCOL_VERSION });
      }
      return reply(peer, i, { version: PROTOCOL_VERSION, users: users.count });
    }
    if (t === REQ.PING) return reply(peer, i, { c: msg.c });

    if (t === REQ.REGISTER || t === REQ.LOGIN) {
      if (!rateOk(peer.remote)) return fail(peer, i, E.RATE);
      const nameErr = nameProblem(msg.name);
      if (nameErr) return fail(peer, i, nameErr);
      const passErr = passProblem(msg.pass);
      if (passErr) return fail(peer, i, passErr);
      const r = t === REQ.REGISTER
        ? users.register(msg.name, msg.pass)
        : users.login(msg.name, msg.pass);
      if (r.error) return fail(peer, i, r.error);
      signIn(peer, r.user);
      return reply(peer, i, {
        token: makeToken(secret, r.user.id),
        user: publicUser(r.user)
      });
    }

    if (t === REQ.RESUME) {
      const id = readToken(secret, msg.token);
      const user = id && users.byId(id);
      if (!user) return fail(peer, i, E.BAD_LOGIN);
      signIn(peer, user);
      // A fresh token on every resume, so somebody who plays weekly is never
      // signed out by an expiry they had no way to see coming.
      return reply(peer, i, {
        token: makeToken(secret, user.id),
        user: publicUser(user)
      });
    }

    /* --- everything below needs a session -------------------------- */
    const me = users.byId(peer.data.userId);
    if (!me) return fail(peer, i, E.UNAUTHED);

    switch (t) {
      case REQ.LOGOUT: {
        detach(peer, 'logout');
        peer.data.userId = null;
        return reply(peer, i, {});
      }

      /* ------------------------------------------------------ friends */
      case REQ.FRIEND_LIST:
        return reply(peer, i, friendsPayload(me.id));

      case REQ.FRIEND_ADD: {
        const r = users.requestFriend(me.id, msg.name);
        if (r.error) return fail(peer, i, r.error);
        pushFriends(me.id);
        pushFriends(r.user.id);
        if (r.status === 'accepted') { pushPresence(me.id); pushPresence(r.user.id); }
        return reply(peer, i, { status: r.status, user: publicUser(r.user) });
      }

      case REQ.FRIEND_ACCEPT: {
        const r = users.acceptFriend(me.id, String(msg.id || ''));
        if (r.error) return fail(peer, i, r.error);
        pushFriends(me.id);
        pushFriends(msg.id);
        pushPresence(me.id);
        pushPresence(msg.id);
        return reply(peer, i, {});
      }

      case REQ.FRIEND_DECLINE: {
        const r = users.declineFriend(me.id, String(msg.id || ''));
        if (r.error) return fail(peer, i, r.error);
        pushFriends(me.id);
        pushFriends(msg.id);
        return reply(peer, i, {});
      }

      case REQ.FRIEND_REMOVE: {
        users.removeFriend(me.id, String(msg.id || ''));
        pushFriends(me.id);
        pushFriends(msg.id);
        return reply(peer, i, {});
      }

      /* -------------------------------------------------------- lobby */
      case REQ.ROOM_CREATE: {
        const existing = rooms.forUser(me.id);
        if (existing && existing.state === 'playing') return fail(peer, i, E.ROOM_BUSY);
        if (existing) leaveRoom(me.id);
        const room = rooms.create(me);
        pushRoom(room);
        pushPresence(me.id);
        return reply(peer, i, { room: rooms.publicRoom(room) });
      }

      case REQ.ROOM_JOIN: {
        const room = rooms.get(msg.roomId);
        if (!room) return fail(peer, i, E.NO_ROOM);
        if (room.state === 'playing') return fail(peer, i, E.ROOM_BUSY);
        // Invite only. The room id is short and readable on purpose, so it is
        // a handle rather than a secret — being invited is the permission.
        if (!rooms.isInvited(room, me.id) && room.hostId !== me.id
            && !rooms.seatOf(room, me.id)) {
          return fail(peer, i, E.NOT_FRIEND);
        }
        const r = rooms.join(room, me);
        if (r.error) return fail(peer, i, r.error === 'room.full' ? E.ROOM_FULL : E.NO_ROOM);
        pushRoom(room);
        pushPresence(me.id);
        return reply(peer, i, { room: rooms.publicRoom(room) });
      }

      case REQ.ROOM_LEAVE: {
        leaveRoom(me.id);
        peer.send({ t: PUSH.ROOM, room: null });
        return reply(peer, i, {});
      }

      case REQ.ROOM_INVITE: {
        const room = rooms.forUser(me.id);
        if (!room) return fail(peer, i, E.NO_ROOM);
        if (room.state === 'playing') return fail(peer, i, E.ROOM_BUSY);
        const targetId = String(msg.userId || '');
        if (!users.areFriends(me.id, targetId)) return fail(peer, i, E.NOT_FRIEND);
        if (room.seats.every(s => s.kind !== 'empty')) return fail(peer, i, E.ROOM_FULL);
        rooms.invite(room, targetId);
        toUser(targetId, {
          t: PUSH.INVITE,
          roomId: room.id,
          from: publicUser(me),
          settings: { ...room.settings }
        });
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

      case REQ.ROOM_READY: {
        const room = rooms.forUser(me.id);
        if (!room) return fail(peer, i, E.NO_ROOM);
        rooms.setReady(room, me.id, !!msg.ready);
        pushRoom(room);
        return reply(peer, i, {});
      }

      case REQ.ROOM_START: {
        const room = rooms.forUser(me.id);
        if (!room) return fail(peer, i, E.NO_ROOM);
        if (room.hostId !== me.id) return fail(peer, i, E.NOT_HOST);
        if (room.state === 'playing') return fail(peer, i, E.ROOM_BUSY);
        const started = startMatch(room);
        if (started.error) return fail(peer, i, started.error);
        return reply(peer, i, { matchId: started.matchId });
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
        if (seat) matches.peer(seat.matchId, seat.pid, 'bot');
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
    matchOf.set(started.matchId, { roomId: room.id, roster, byUser, seed });
    rooms.beginMatch(room, started.matchId);
    pushRoom(room);
    for (const uid of rooms.members(room)) pushPresence(uid);
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
          knights: msg.knights
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
      for (const [userId, pid] of info.byUser) {
        users.noteResult(userId, msg.winner === pid);
      }
      broadcast(info, { ...msg, t: type });
      if (room) {
        rooms.endMatch(room);
        pushRoom(room);
        for (const uid of rooms.members(room)) pushPresence(uid);
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
      for (const uid of rooms.members(room)) pushPresence(uid);
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  function leaveRoom(userId) {
    const room = rooms.forUser(userId);
    if (!room) return;
    // Walking out of a lobby mid-match hands your settler to a bot rather
    // than deleting it: the island already has your roads on it.
    if (room.state === 'playing' && room.matchId) {
      const info = matchOf.get(room.matchId);
      const pid = info && info.byUser.get(userId);
      if (pid !== undefined) matches.peer(room.matchId, pid, 'bot');
    }
    const r = rooms.leave(userId);
    if (r && !r.dissolved) pushRoom(r.room);
    pushPresence(userId);
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
    pushPresence(userId);
  }

  /* When a dropped player comes back and their seat is still theirs, put them
     back behind it. `signIn` re-sends the room; this puts the settler back
     under their control and tells the table. */
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
        users: users.count
      };
    }
  };
}

export default createHub;
