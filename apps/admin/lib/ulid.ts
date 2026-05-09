/**
 * ULID utilities for the admin app (ADR-028 / ADR-029).
 *
 * Mirrors `apps/api/src/common/ulid.ts` but uses Web Crypto's
 * `crypto.getRandomValues` instead of Node's `randomBytes` so the
 * function works in every Next.js runtime (Node + Edge). The
 * encoded shape is identical: 26 Crockford-base32 characters,
 * matching `audit_event` and `RequestIdMiddleware`.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The Crockford base32 ULID format the platform uses everywhere
 * (ADR-028 RequestIdMiddleware regex). 0–9, A–Z excluding I, L, O, U.
 */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Returns a fresh 26-char Crockford-base32 ULID. Uses
 * `globalThis.crypto.getRandomValues` for portability across the
 * Node and Edge runtimes Next.js exposes.
 */
export function newUlid(): string {
  const timeMs = BigInt(Date.now());
  const rnd = new Uint8Array(10);
  globalThis.crypto.getRandomValues(rnd);
  let rndBig = 0n;
  for (let i = 0; i < 10; i++) {
    rndBig = (rndBig << 8n) | BigInt(rnd[i]!);
  }
  let bits = (timeMs << 80n) | rndBig;
  let id = '';
  for (let i = 0; i < 26; i++) {
    id = ALPHABET[Number(bits & 31n)] + id;
    bits = bits >> 5n;
  }
  return id;
}

/**
 * Returns the input untouched if it is a valid ULID, otherwise
 * `undefined`. Use this on inbound `X-Request-Id` headers to decide
 * whether to propagate or regenerate.
 */
export function validUlid(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  return ULID_PATTERN.test(value) ? value : undefined;
}
