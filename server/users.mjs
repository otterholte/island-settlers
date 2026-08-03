/**
 * Island Settlers — accounts and the friend graph.
 *
 *   createUsers(store) -> { register, login, byId, byName, ... friends ... }
 *
 * Everything here is synchronous and in memory; `store.save()` schedules the
 * write. No request handling, no sockets, no notion of who is online — the hub
 * owns all of that and this file owns only what is true between restarts.
 *
 * THE FRIEND GRAPH IS SYMMETRIC AND STORED TWICE
 * ----------------------------------------------
 * `friends[a]` contains b and `friends[b]` contains a. Storing an undirected
 * edge once and searching both ends on every read is the tidier data structure
 * and the wrong one here: the only question ever asked is "who are MY friends",
 * asked on every sign-in and every presence change. Two writes at accept time
 * buy an O(1) read forever. `addFriend` and `removeFriend` are the only places
 * that may touch either side, so the two halves cannot drift.
 *
 * A REQUEST IS NOT AN EDGE
 * ------------------------
 * `requests[b]` holds `{ from: a }` until b accepts. Until then a is not in
 * b's friend list and b is not in a's — an unanswered request grants nothing
 * and reveals nothing beyond the name that was typed. Accepting turns one
 * pending request into the two edges above and deletes the request.
 *
 * Owner: net agent.
 */

import { nameKey, nameProblem, passProblem, E } from '../src/net/protocol.js';
import { hashPassword, verifyPassword } from './auth.mjs';

/** A friend list this long is already past what four seats can use. It exists
 *  so one account cannot be used to grow the file without bound. */
const MAX_FRIENDS = 200;
const MAX_REQUESTS = 100;

export function createUsers(store) {
  const d = store.data;

  /* ---------------------------------------------------------------- reads */

  const byId = id => (id ? d.users[id] || null : null);
  const byName = name => byId(d.byName[nameKey(name)]);

  function friendIds(id) {
    const list = d.friends[id];
    return Array.isArray(list) ? list : [];
  }

  function areFriends(a, b) {
    return friendIds(a).includes(b);
  }

  function incoming(id) {
    const list = d.requests[id];
    return Array.isArray(list) ? list : [];
  }

  /** Requests this user has SENT: the mirror of `incoming`, computed rather
   *  than stored. It is only ever read for one user at a time on the friends
   *  screen, and a stored copy would be a third thing to keep in step. */
  function outgoing(id) {
    const out = [];
    for (const targetId of Object.keys(d.requests)) {
      for (const r of d.requests[targetId]) {
        if (r.from === id) out.push({ id: targetId, at: r.at });
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- writes */

  function register(name, pass) {
    const nameErr = nameProblem(name);
    if (nameErr) return { error: nameErr };
    const passErr = passProblem(pass);
    if (passErr) return { error: passErr };

    const key = nameKey(name);
    if (d.byName[key]) return { error: E.NAME_TAKEN };

    const { hash, salt } = hashPassword(pass);
    const id = `u${d.nextId++}`;
    const user = {
      id,
      name: String(name).trim(),
      key,
      hash,
      salt,
      created: Date.now(),
      lastSeen: Date.now(),
      stats: { played: 0, won: 0 }
    };
    d.users[id] = user;
    d.byName[key] = id;
    d.friends[id] = [];
    d.requests[id] = [];
    store.save();
    return { user };
  }

  function login(name, pass) {
    const user = byName(name);
    // The same error whether the name is unknown or the password is wrong.
    // Telling them apart turns the sign-in form into a way to find out which
    // names exist, which is the first half of guessing a password.
    if (!user) {
      // Still spend the time: an instant "no" for an unknown name and a slow
      // one for a known name is the same leak measured with a stopwatch.
      verifyPassword(String(pass), DUMMY.hash, DUMMY.salt);
      return { error: E.BAD_LOGIN };
    }
    if (!verifyPassword(String(pass), user.hash, user.salt)) return { error: E.BAD_LOGIN };
    user.lastSeen = Date.now();
    store.save();
    return { user };
  }

  function touch(id) {
    const u = byId(id);
    if (!u) return null;
    u.lastSeen = Date.now();
    store.save();
    return u;
  }

  /**
   * Ask to be somebody's friend.
   *
   * Three outcomes worth separating, because they are three different things
   * to say on screen:
   *   'sent'      the request is now waiting for them
   *   'accepted'  they had already asked you, so this completes it both ways
   *   an error    which is one of E.NO_USER / E.SELF / E.ALREADY
   */
  function requestFriend(fromId, name) {
    const target = byName(name);
    if (!target) return { error: E.NO_USER };
    if (target.id === fromId) return { error: E.SELF };
    if (areFriends(fromId, target.id)) return { error: E.ALREADY };

    // If they already asked us, typing their name back is an acceptance. The
    // alternative is two people staring at each other's pending requests.
    const mine = incoming(fromId);
    if (mine.some(r => r.from === target.id)) {
      acceptFriend(fromId, target.id);
      return { status: 'accepted', user: target };
    }

    const theirs = incoming(target.id);
    if (theirs.some(r => r.from === fromId)) return { status: 'sent', user: target };
    if (theirs.length >= MAX_REQUESTS) return { error: E.RATE };

    theirs.push({ from: fromId, at: Date.now() });
    d.requests[target.id] = theirs;
    store.save();
    return { status: 'sent', user: target };
  }

  function acceptFriend(id, fromId) {
    const list = incoming(id);
    const at = list.findIndex(r => r.from === fromId);
    if (at < 0) return { error: E.NO_USER };
    list.splice(at, 1);
    d.requests[id] = list;

    const a = friendIds(id), b = friendIds(fromId);
    if (a.length >= MAX_FRIENDS || b.length >= MAX_FRIENDS) {
      store.save();
      return { error: E.RATE };
    }
    if (!a.includes(fromId)) a.push(fromId);
    if (!b.includes(id)) b.push(id);
    d.friends[id] = a;
    d.friends[fromId] = b;
    store.save();
    return { ok: true, other: byId(fromId) };
  }

  function declineFriend(id, fromId) {
    const list = incoming(id);
    const at = list.findIndex(r => r.from === fromId);
    if (at < 0) return { error: E.NO_USER };
    list.splice(at, 1);
    d.requests[id] = list;
    store.save();
    return { ok: true };
  }

  /** Also used to cancel a request you sent, since "remove" from either side
   *  should leave no trace of the relationship in either direction. */
  function removeFriend(id, otherId) {
    const a = friendIds(id).filter(x => x !== otherId);
    const b = friendIds(otherId).filter(x => x !== id);
    d.friends[id] = a;
    d.friends[otherId] = b;
    d.requests[id] = incoming(id).filter(r => r.from !== otherId);
    d.requests[otherId] = incoming(otherId).filter(r => r.from !== id);
    store.save();
    return { ok: true };
  }

  function noteResult(id, won) {
    const u = byId(id);
    if (!u) return;
    u.stats = u.stats || { played: 0, won: 0 };
    u.stats.played++;
    if (won) u.stats.won++;
    store.save();
  }

  return {
    byId, byName, friendIds, areFriends, incoming, outgoing,
    register, login, touch,
    requestFriend, acceptFriend, declineFriend, removeFriend, noteResult,
    get count() { return Object.keys(d.users).length; }
  };
}

/* A throwaway hash used only to burn the same milliseconds on an unknown name
   as on a known one. Computed once at module load, never compared to anything
   a user typed for any purpose other than wasting exactly the right amount of
   time. */
const DUMMY = hashPassword('there-is-no-account-here');

export default createUsers;
