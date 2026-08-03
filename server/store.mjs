/**
 * Island Settlers — persistence.
 *
 *   openStore(path) -> { data, save(), flush(), stats }
 *
 * One JSON file, held in memory, written back atomically and on a delay.
 *
 * WHY A JSON FILE
 * ---------------
 * The thing being stored is a few hundred accounts and who is friends with
 * whom. It is read once at boot and written when somebody signs up or adds a
 * friend — call it a handful of writes an hour at the busiest this will ever
 * be. A database would be a second thing to install, a second thing to back
 * up, a second thing to be down, and a schema migration every time a field
 * moves. `node:sqlite` exists on Node 22 but is still flagged experimental and
 * would print a warning at every boot for no benefit at this size.
 *
 * The honest limit: this design assumes one server process. That is exactly
 * what Fly runs by default, and the day it is not, this file is the thing to
 * replace — nothing above it knows how the bytes land.
 *
 * WHY ATOMIC
 * ----------
 * Write straight into the live file and a process that dies mid-write leaves a
 * truncated JSON file, which on the next boot means every account is gone.
 * Write to a sibling and rename: rename is atomic within a filesystem, so the
 * file a reader sees is always either wholly the old one or wholly the new.
 * The cost is one extra inode for a few milliseconds.
 *
 * WHY DEBOUNCED
 * -------------
 * Accepting a friend request touches both users, which is two saves that want
 * to be one file write. Batching by DEBOUNCE_MS collapses every burst, and
 * `flush()` on shutdown means nothing is lost by the batching.
 *
 * Owner: net agent.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEBOUNCE_MS = 400;
/** However busy it gets, never go longer than this without hitting the disk. */
const MAX_DEFER_MS = 5000;

const EMPTY = () => ({
  version: 1,
  users: {},        // id -> { id, name, key, hash, salt, created, lastSeen, stats }
  byName: {},       // nameKey -> id
  friends: {},      // id -> [ friendId, ... ]
  requests: {},     // id -> [ { from, at } ]   incoming requests
  nextId: 1
});

export function openStore(path) {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });

  let data = EMPTY();
  let loaded = false;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        data = { ...EMPTY(), ...parsed };
        loaded = true;
      }
    } catch (e) {
      /* A corrupt file is kept, not overwritten. Whatever went wrong, the
         bytes are the only copy of everyone's account and they are worth more
         on disk under a new name than they are deleted by a fresh boot. */
      const bak = `${file}.corrupt.${Date.now()}`;
      try { copyFileSync(file, bak); } catch (e2) { /* best effort */ }
      console.error(`[store] ${file} would not parse — kept a copy at ${bak}`);
    }
  }

  const stats = { loaded, saves: 0, writes: 0, lastWrite: 0, lastError: null, path: file };

  let timer = null;
  let firstDirtyAt = 0;

  /** Returns whether the bytes actually landed. The boot probe in index.mjs
   *  depends on this being the truth rather than a best effort. */
  function writeNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    firstDirtyAt = 0;
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, file);
      stats.writes++;
      stats.lastWrite = Date.now();
      stats.lastError = null;
      return true;
    } catch (e) {
      stats.lastError = (e && e.message) || String(e);
      console.error('[store] write failed:', stats.lastError, '-', file);
      return false;
    }
  }

  function save() {
    stats.saves++;
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    if (now - firstDirtyAt >= MAX_DEFER_MS) return writeNow();
    if (timer) clearTimeout(timer);
    timer = setTimeout(writeNow, DEBOUNCE_MS);
    timer.unref?.();
  }

  return {
    get data() { return data; },
    save,
    flush: writeNow,
    stats
  };
}

export default openStore;
