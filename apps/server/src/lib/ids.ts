/**
 * Identifier generation.
 *
 * Every primary key in this app is a ULID. Two properties matter here:
 *
 *  1. **Lexicographic order == chronological order.** Message pagination becomes
 *     `WHERE id < ? ORDER BY id DESC LIMIT 50` against the primary key, with no separate
 *     timestamp index and no OFFSET scan. "Is this message newer than my last-read one?"
 *     is a string comparison the client can do locally.
 *  2. **No coordination.** Unlike auto-increment, ids can be minted on any node (or
 *     optimistically on a client) without a round trip.
 *
 * Layout: 48-bit millisecond timestamp (10 chars) + 80 bits of randomness (16 chars),
 * encoded in Crockford base32 -- 26 characters, URL-safe, no ambiguous letters.
 */

import { randomBytes, randomInt } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    const mod = t % ENCODING_LEN;
    out = ENCODING[mod] + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const out = new Array<number>(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    // Modulo bias across a 32-value alphabet from a 256-value byte is exact (256 % 32 === 0).
    out[i] = bytes[i]! % ENCODING_LEN;
  }
  return out;
}

/**
 * Increment the random component in place so that two ids minted in the same
 * millisecond still sort in creation order. Without this, two messages sent in the same
 * millisecond could render out of order.
 */
function incrementRandom(chars: number[]): number[] {
  const out = [...chars];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]! < ENCODING_LEN - 1) {
      out[i] = out[i]! + 1;
      return out;
    }
    out[i] = 0;
  }
  // Overflowed all 80 bits within one millisecond -- practically impossible, but if it
  // ever happens, re-randomising is better than returning a duplicate.
  return randomChars();
}

/** Generate a new time-sortable, monotonic ULID. */
export function newId(time: number = Date.now()): string {
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = time;
    lastRandom = randomChars();
  }
  let random = '';
  for (const c of lastRandom) random += ENCODING[c];
  return encodeTime(time) + random;
}

/** Recover the creation timestamp encoded in a ULID. Returns null if malformed. */
export function idToTimestamp(id: string): number | null {
  if (id.length !== TIME_LEN + RANDOM_LEN) return null;
  let time = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const index = ENCODING.indexOf(id[i]!);
    if (index === -1) return null;
    time = time * ENCODING_LEN + index;
  }
  return time;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

const INVITE_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Short, human-typeable invite code. ~54^8 ≈ 7e13 possibilities. */
export function newInviteCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return out;
}

/** A 4-digit tag appended to a username, e.g. "0417". Never "0000". */
export function newDiscriminator(): string {
  return String(randomInt(1, 10000)).padStart(4, '0');
}
