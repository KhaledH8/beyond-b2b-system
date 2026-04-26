/**
 * Decimal-string ↔ minor-units helpers for the pricing evaluator.
 *
 * Float math is forbidden on money: every conversion goes through
 * BigInt so percent-of-amount is bit-exact. The two zero-decimal
 * currencies relevant to travel inventory are listed explicitly;
 * anything else is treated as a 2-decimal currency. ADR-020 forbids
 * silent currency assumptions, so the table is small and obvious —
 * adding a currency is a deliberate edit, not a guess.
 */

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'ISK']);

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Parse a decimal-string amount (e.g. "120.50") into integer minor
 * units for the given currency. Inputs are trusted to be well-formed
 * decimal strings as produced by suppliers and our own DB; malformed
 * input throws rather than silently coercing.
 */
export function toMinorUnits(amount: string, currency: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Money: invalid decimal amount "${amount}"`);
  }
  const exponent = minorUnitExponent(currency);
  const negative = amount.startsWith('-');
  const abs = negative ? amount.slice(1) : amount;
  const [whole = '0', fractionRaw = ''] = abs.split('.');
  const fraction = (fractionRaw + '0'.repeat(exponent)).slice(0, exponent);
  const minor = BigInt(whole + fraction);
  return negative ? -minor : minor;
}

export function fromMinorUnits(minor: bigint, currency: string): string {
  const exponent = minorUnitExponent(currency);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  if (exponent === 0) {
    return (negative ? '-' : '') + abs.toString();
  }
  const padded = abs.toString().padStart(exponent + 1, '0');
  const whole = padded.slice(0, -exponent);
  const fraction = padded.slice(-exponent);
  return (negative ? '-' : '') + whole + '.' + fraction;
}

/**
 * Apply a percent value (decimal string, e.g. "10.0000" = 10%) to a
 * minor-units amount. We scale the percent to basis-points-of-
 * basis-points (10^6 denominator) for sub-percent precision; final
 * rounding is half-away-from-zero so a 10% markup on 100.50 EUR is
 * 10.05 EUR, not the bias-prone banker's-rounding 10.04.
 *
 * Returns the markup amount (NOT the new total). Caller adds it to
 * the net amount.
 */
export function applyPercentMarkup(
  netMinor: bigint,
  percentValue: string,
): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(percentValue)) {
    throw new Error(`Money: invalid percent "${percentValue}"`);
  }
  // Scale percent to integer hundred-thousandths (10^5) so up to 4
  // decimal places are preserved. Then divide by (100 * 10^5) = 10^7
  // to convert percent → multiplier.
  const negative = percentValue.startsWith('-');
  const abs = negative ? percentValue.slice(1) : percentValue;
  const [whole = '0', fractionRaw = ''] = abs.split('.');
  const fraction = (fractionRaw + '00000').slice(0, 5);
  const scaled = BigInt(whole + fraction);
  const numerator = netMinor * scaled;
  const denominator = 10_000_000n;
  // Half-away-from-zero rounding.
  const result = roundHalfAwayFromZero(numerator, denominator);
  return negative ? -result : result;
}

function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const halfUp = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -halfUp : halfUp;
}
