import { randomBytes } from 'crypto';

/**
 * Minimal ULID generator.
 *
 * The DB stores identifiers as `CHAR(26)`. A real ULID is 48 bits of
 * millisecond timestamp followed by 80 bits of randomness, Crockford-
 * base32 encoded to exactly 26 chars. We hand-roll the encoder here so
 * the api package does not take a dependency on a third-party ULID
 * library for a 20-line routine. Replace with `ulid` npm package if we
 * ever need monotonic sequences across the same millisecond.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newUlid(): string {
  const timeMs = BigInt(Date.now());
  const rnd = randomBytes(10);
  let rndBig = 0n;
  for (let i = 0; i < 10; i++) {
    rndBig = (rndBig << 8n) | BigInt(rnd[i]!);
  }
  let bits = (timeMs << 80n) | rndBig;
  let id = '';
  for (let i = 0; i < 26; i++) {
    id = ALPHABET[Number(bits & 31n)] + id;
    bits >>= 5n;
  }
  return id;
}
