/**
 * Island Settlers — what colour is seat N, right now?
 *
 *   useSeats(state.players)      once, at boot
 *   seatHex(pid) -> 0xRRGGBB     the owner colour, live
 *   seatLight(pid) -> '#rrggbb'  its pale variant, for tints over terrain
 *
 * WHY THIS EXISTS.
 *
 *   "The player's own character and the colours on the MAP VIEW look the same
 *    on both screens, but in the close-up 3D game, on player one's screen the
 *    roads they built were blue, and for the other player the same roads were
 *    purple — and one of the bots was building blue things."
 *
 * `PLAYER_COLORS` in constants.js is the DEFAULT palette, indexed 0..3, and
 * everything that draws an owned thing used to index straight into it. In a
 * single-player match that is correct by definition: seat 2 is the third
 * colour, on every machine, because there is only one machine.
 *
 * Online it is wrong in a way that is invisible from one chair. `mirror.js`
 * renumbers the seats so the local player is always index 0 — you are always
 * "you" — and re-assigns each seat the colour the SERVER gave it. So local
 * index 2 is a different person on each device, and the colour that belongs to
 * them is on `state.players[2].color`, not at `PLAYER_COLORS[2]`.
 *
 * The pieces that read the live player object — the standings, the board map,
 * the settlers themselves — were right, which is exactly why this was so
 * strange to look at: your friend's settler was the right colour and the roads
 * coming out of it were not.
 *
 * The fix is one indirection, in one place. `useSeats` is handed the match's
 * player array — the SAME array the mirror mutates in place — so every reader
 * picks up a re-seat automatically and nothing needs to be told twice. With no
 * match installed it falls back to the default palette, which is what the
 * opening screen, the rules book and the art rigs want.
 *
 * Owner: world agent.
 */

import { PLAYER_COLORS } from './constants.js';

let seats = null;

/**
 * Point the lookup at a live match.
 *
 * Pass the state's own `players` array, not a copy: the whole point is that
 * `mirror.js` assigns `p.color` on those objects and every renderer that has
 * already drawn something is asking again next frame.
 */
export function useSeats(players) {
  seats = Array.isArray(players) && players.length ? players : null;
  return !!seats;
}

/** Forget the match. The default palette answers again. */
export function clearSeats() { seats = null; }

/** The colour record for a seat — live if there is a match, default if not. */
export function seatColor(pid) {
  const n = PLAYER_COLORS.length;
  const i = ((pid | 0) % n + n) % n;
  const live = seats && seats[i] && seats[i].color;
  return live || PLAYER_COLORS[i] || PLAYER_COLORS[0];
}

/** Owner colour as a hex number, safe against a stray player id. */
export function seatHex(pid) {
  const c = seatColor(pid);
  return c && Number.isFinite(c.hex) ? c.hex : 0xffffff;
}

/** The pale variant, for washes laid over terrain where the base reads muddy. */
export function seatLight(pid) {
  const c = seatColor(pid);
  return (c && c.light) || '#93cbff';
}

/** The css string, for the DOM side. */
export function seatCss(pid) {
  const c = seatColor(pid);
  return (c && c.css) || '#5b9bd5';
}

export default { useSeats, clearSeats, seatColor, seatHex, seatLight, seatCss };
