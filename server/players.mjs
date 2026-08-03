/**
 * Island Settlers — who is connected.
 *
 *   createPlayers() -> { session, byId, rename, forget, count, sweep }
 *
 * This replaced accounts. There is no register, no login, no password hash, no
 * token and no store:
 *
 *   "Remove adding friends, remove accepting players... but users can still add
 *    their name and it stays saved locally on the device."
 *
 * A player is a device id the browser made up once and a name they typed on
 * their own machine. Both arrive on `hello`. Everything here lives in memory
 * and is gone when the process exits, which is correct rather than lazy: a
 * server that is not running holds no rooms and no matches either, so there is
 * nothing for a persisted identity to reattach to.
 *
 * WHY A DEVICE ID AND NOT JUST A NAME
 * -----------------------------------
 * Because the seat has to survive a reload. The client reloads the page between
 * the lobby and the first frame of the match (the board is re-dealt from the
 * server's seed before the world modules import, which cannot be done under a
 * live scene), and it reloads again whenever somebody's phone drops wi-fi in a
 * tunnel. The device id is what says "this is the same person, give them their
 * settler back" without asking anybody to type a password to get back into a
 * game they are already in.
 *
 * Names are NOT unique and are not checked against each other. Two friends
 * called Sam in one room is a thing they will sort out between themselves.
 *
 * Owner: net agent.
 */

import { randomBytes } from 'node:crypto';
import { cleanName, nameProblem } from '../src/net/protocol.js';

/** A device we have not heard from in this long is forgotten. Only matters for
 *  memory: a returning device just gets a new record and a new id. */
const IDLE_MS = 12 * 3600 * 1000;

/** A device id we did not issue is still accepted — it is the client's own
 *  handle — but it is length-capped so a hostile client cannot post megabytes
 *  of key into a Map. */
const DEVICE_MAX = 64;

export function createPlayers() {
  const byDevice = new Map();   // device -> player
  const byIdMap = new Map();    // id -> player

  function cleanDevice(d) {
    const s = String(d == null ? '' : d).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, DEVICE_MAX);
    return s.length >= 8 ? s : '';
  }

  /**
   * The whole of sign-in.
   *
   * Known device -> the same player, with the name refreshed to whatever they
   * are calling themselves today. Unknown or missing device -> a new player,
   * and the id we hand back is the one the client should keep.
   */
  function session(device, name) {
    const key = cleanDevice(device);
    const nice = cleanName(name) || 'Settler';
    if (nameProblem(nice)) return { error: nameProblem(nice) };

    let p = key && byDevice.get(key);
    if (p) {
      p.name = nice;
      p.seenAt = Date.now();
      return { player: p };
    }
    p = {
      id: randomBytes(8).toString('hex'),
      device: key || randomBytes(8).toString('hex'),
      name: nice,
      joinedAt: Date.now(),
      seenAt: Date.now()
    };
    byDevice.set(p.device, p);
    byIdMap.set(p.id, p);
    return { player: p, fresh: true };
  }

  function byId(id) {
    return (id && byIdMap.get(id)) || null;
  }

  function rename(id, name) {
    const p = byId(id);
    if (!p) return { error: 'unknown' };
    const nice = cleanName(name);
    const bad = nameProblem(nice);
    if (bad) return { error: bad };
    p.name = nice;
    p.seenAt = Date.now();
    return { player: p };
  }

  function touch(id) {
    const p = byId(id);
    if (p) p.seenAt = Date.now();
  }

  /** Drop records for devices nobody is using and nothing is holding. `inUse`
   *  is asked for every id the rest of the server still cares about. */
  function sweep(inUse = () => false) {
    const now = Date.now();
    for (const p of [...byIdMap.values()]) {
      if (now - p.seenAt < IDLE_MS) continue;
      if (inUse(p.id)) continue;
      byIdMap.delete(p.id);
      byDevice.delete(p.device);
    }
  }

  return {
    session, byId, rename, touch, sweep,
    get count() { return byIdMap.size; },
    all: () => [...byIdMap.values()]
  };
}

export default createPlayers;
