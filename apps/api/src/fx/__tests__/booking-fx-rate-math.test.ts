import { describe, expect, it } from 'vitest';
import {
  applyRateToMinor,
  parseRateToScaledBigInt,
  roundHalfAwayFromZero,
} from '../booking-fx-rate-math';

/**
 * Pure unit tests for the shared booking FX rate math (ADR-024 C5d.2).
 *
 * These exercise the same primitives that the resolver and the
 * refund/cancellation-fee applier both depend on; if rounding ever
 * drifts between the two paths a customer's REFUND chargeMinor could
 * differ by ±1 from the proportion of what they were charged at
 * confirmation time.
 */

describe('applyRateToMinor', () => {
  it('multiplies and rounds to whole minor units (DIRECT case)', () => {
    // 10000 USD-minor × 0.78 GBP-per-USD = 7800 GBP-minor
    expect(applyRateToMinor(10000n, '0.78000000')).toBe(7800n);
  });

  it('rounds half-away-from-zero on positive amounts', () => {
    // 1000 × 0.99999999 = 999.99999 → 1000
    expect(applyRateToMinor(1000n, '0.99999999')).toBe(1000n);
  });

  it('rounds toward zero when the fractional part is below 0.5', () => {
    // 1000 × 0.78001234 = 780.01234 → 780
    expect(applyRateToMinor(1000n, '0.78001234')).toBe(780n);
  });

  it('rounds away from zero when the fractional part is exactly 0.5', () => {
    // Crafted: 2 × 0.50000000 = 1.0 (no rounding edge here)
    // Exact 0.5: 1 × 0.50000000 = 0.5 → rounds away to 1
    expect(applyRateToMinor(1n, '0.50000000')).toBe(1n);
  });

  it('handles a rate > 1 (inverse direction)', () => {
    // 7800 GBP-minor × (1/0.78) ≈ 1.282 → 7800 × 1.28205128 = 9999.9999984 → 10000
    expect(applyRateToMinor(7800n, '1.28205128')).toBe(10000n);
  });

  it('handles large amounts without precision loss (BigInt path)', () => {
    // 1_000_000_000_000n × 0.5 = 500_000_000_000
    expect(applyRateToMinor(1_000_000_000_000n, '0.50000000')).toBe(
      500_000_000_000n,
    );
  });

  it('handles zero source amount', () => {
    expect(applyRateToMinor(0n, '0.78003120')).toBe(0n);
  });

  it('throws on a rate string with more than 8 decimal places', () => {
    expect(() => applyRateToMinor(100n, '0.123456789')).toThrow(/Invalid rate/);
  });

  it('throws on a non-numeric rate string', () => {
    expect(() => applyRateToMinor(100n, 'NaN')).toThrow(/Invalid rate/);
  });
});

describe('parseRateToScaledBigInt', () => {
  it('scales a whole number to 10^8', () => {
    expect(parseRateToScaledBigInt('1')).toBe(100_000_000n);
  });

  it('scales a fractional number with all 8 decimals present', () => {
    expect(parseRateToScaledBigInt('0.78003120')).toBe(78_003_120n);
  });

  it('right-pads a partial fraction to 8 decimals', () => {
    expect(parseRateToScaledBigInt('0.78')).toBe(78_000_000n);
  });

  it('handles a negative rate', () => {
    expect(parseRateToScaledBigInt('-1.5')).toBe(-150_000_000n);
  });
});

describe('roundHalfAwayFromZero', () => {
  it('rounds positive .5 up (away from zero)', () => {
    expect(roundHalfAwayFromZero(5n, 10n)).toBe(1n);
  });

  it('rounds negative .5 down (away from zero)', () => {
    expect(roundHalfAwayFromZero(-5n, 10n)).toBe(-1n);
  });

  it('returns zero when numerator is zero', () => {
    expect(roundHalfAwayFromZero(0n, 10n)).toBe(0n);
  });

  it('rounds toward zero when fraction < 0.5', () => {
    expect(roundHalfAwayFromZero(4n, 10n)).toBe(0n);
    expect(roundHalfAwayFromZero(-4n, 10n)).toBe(0n);
  });
});
