/**
 * Shared FX rate math for booking-time FX locks (ADR-024 C5).
 *
 * The resolver (C5b) and the refund/cancellation-fee applier (C5d.2)
 * both need to multiply a minor-unit `bigint` source amount by a
 * rate string and round half-away-from-zero to a whole minor unit.
 * The two paths must produce byte-identical results: a refund derived
 * from a CONFIRMATION row's `rate` must round the same way the
 * confirmation's `chargeMinor` was rounded, otherwise REFUND chargeMinor
 * could drift by ±1 from what the customer was charged.
 *
 * This module is the single source of those primitives. It has no
 * runtime dependencies and no DI; both call sites import it directly.
 *
 * Rate string contract: `^-?\d+(\.\d{1,8})?$` — up to 8 decimal places.
 * Both providers (Stripe inverted, OXR snapshot) emit rates in this
 * format. Anything outside this shape throws — callers should never
 * pass a rate they did not just persist or read from the DB.
 */

const RATE_SCALE = 100_000_000n; // 10^8

/**
 * Multiplies a minor-unit `bigint` by an 8-decimal rate string and
 * rounds half-away-from-zero to a whole minor unit.
 *
 * Implementation rationale: the rate is at most 8 decimals; we scale
 * to integer arithmetic (rate × 10^8) and use BigInt division so we
 * never lose precision on large amounts. Float multiplication would
 * be acceptable here in isolation (booking amounts fit comfortably in
 * Number's safe-integer range) but the bigint path is cheap and keeps
 * the audit reconstructible to the last unit.
 */
export function applyRateToMinor(sourceMinor: bigint, rate: string): bigint {
  const rateScaled = parseRateToScaledBigInt(rate);
  // chargeMinor = round(sourceMinor × rate) where rate is fraction
  // (rateScaled / 10^8). Half-away-from-zero rounding via:
  //   floor((|x| × 2 + denominator) / (denominator × 2)) × sign
  const numerator = sourceMinor * rateScaled;
  return roundHalfAwayFromZero(numerator, RATE_SCALE);
}

export function parseRateToScaledBigInt(rate: string): bigint {
  if (!/^-?\d+(\.\d{1,8})?$/.test(rate)) {
    throw new Error(`Invalid rate "${rate}": expected up to 8 decimal places`);
  }
  const negative = rate.startsWith('-');
  const abs = negative ? rate.slice(1) : rate;
  const [whole = '0', fractionRaw = ''] = abs.split('.');
  const fraction = (fractionRaw + '00000000').slice(0, 8);
  const scaled = BigInt(whole + fraction);
  return negative ? -scaled : scaled;
}

export function roundHalfAwayFromZero(
  numerator: bigint,
  denominator: bigint,
): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const halfUp = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -halfUp : halfUp;
}
