/**
 * Island Settlers — passwords and sessions.
 *
 *   hashPassword(pass) -> { hash, salt }
 *   verifyPassword(pass, hash, salt) -> bool
 *   makeToken(secret, userId, ttlSec) -> string
 *   readToken(secret, token) -> userId | null
 *
 * Built entirely on `node:crypto`. No bcrypt, no jsonwebtoken, no argon2.
 *
 * PASSWORDS: scrypt
 * -----------------
 * scrypt is in the standard library, is deliberately memory-hard, and is the
 * right answer when the alternative is a native module the project cannot
 * install. Parameters below are the tuned-for-a-small-server kind: N=2^15
 * costs about 60ms and 32MB per hash on the machine this runs on, which is
 * slow enough to make an offline guessing attack expensive and fast enough
 * that signing in does not feel broken.
 *
 * Every password gets its own 16-byte salt, so two people who pick the same
 * password do not get the same hash and one rainbow table buys nothing.
 * Comparison is `timingSafeEqual`, because a plain `===` on a hash leaks how
 * many leading bytes were right to anyone patient enough to measure.
 *
 * TOKENS: HMAC, not JWT
 * ---------------------
 * A session token here needs to say two things — who you are and when it
 * stops being true — and needs to be unforgeable. That is a string and a
 * signature over it. JWT would add a base64 header announcing which algorithm
 * to trust, which is famously the part that goes wrong.
 *
 *   token = base64url( "<userId>.<expiryMs>" ) + "." + base64url( hmac )
 *
 * The server keeps no session table: the token IS the session, and it expires
 * because the expiry is inside the signed part. The cost of that trade is that
 * a token cannot be revoked before it expires — acceptable for a game, and the
 * reason the lifetime is thirty days rather than forever. Rotating SESSION_SECRET
 * invalidates every token at once, which is the emergency exit.
 *
 * Owner: net agent.
 */

import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;

/** Thirty days. Long enough that a player is never asked twice in a season,
 *  short enough that a token copied off an old device stops working. */
export const TOKEN_TTL_SEC = 30 * 24 * 3600;

export function hashPassword(pass) {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(String(pass), salt, SCRYPT.keylen, SCRYPT);
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}

export function verifyPassword(pass, hashB64, saltB64) {
  if (!hashB64 || !saltB64) return false;
  let want, salt;
  try {
    want = Buffer.from(hashB64, 'base64');
    salt = Buffer.from(saltB64, 'base64');
  } catch (e) {
    return false;
  }
  if (!want.length || !salt.length) return false;
  let got;
  try {
    got = scryptSync(String(pass), salt, want.length, SCRYPT);
  } catch (e) {
    return false;
  }
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function makeToken(secret, userId, ttlSec = TOKEN_TTL_SEC) {
  const exp = Date.now() + ttlSec * 1000;
  const body = Buffer.from(`${userId}.${exp}`, 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Returns the user id, or null for anything at all wrong: bad shape, bad
 *  signature, expired. The caller never needs to know which, and telling it
 *  apart is not information a client should have. */
export function readToken(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const want = sign(secret, body);
  // Both are base64url of a 32-byte digest, so they are the same length
  // whenever the token is even roughly the right shape — but check anyway,
  // because timingSafeEqual throws on a length mismatch.
  if (mac.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;

  let plain;
  try {
    plain = Buffer.from(body, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
  const cut = plain.lastIndexOf('.');
  if (cut <= 0) return null;
  const id = plain.slice(0, cut);
  const exp = Number(plain.slice(cut + 1));
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return id || null;
}

/**
 * The signing secret.
 *
 * Set SESSION_SECRET in the environment and every restart keeps everyone
 * signed in. Leave it unset and one is generated per boot, which means a
 * restart signs everybody out — fine for local development, loud about it in
 * the log so it is not a surprise in production.
 */
export function sessionSecret(env = process.env) {
  const s = env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (s) console.warn('[auth] SESSION_SECRET is shorter than 16 chars — ignoring it');
  console.warn('[auth] no SESSION_SECRET set — generating one; every restart will sign players out');
  return randomBytes(32).toString('base64');
}

export default { hashPassword, verifyPassword, makeToken, readToken, sessionSecret };
