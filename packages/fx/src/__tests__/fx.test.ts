import { describe, expect, it } from 'vitest';
import { findFreshestSnapshot, type FxSnapshot } from '../rate-lookup';
import { deriveCrossRate } from '../cross-rate';
import { applyFx, type FxConfig } from '../apply-fx';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const NOW = new Date('2025-04-27T14:00:00Z');

// Timestamp 30 minutes before NOW — within a 60-minute TTL.
const FRESH = '2025-04-27T13:30:00Z';
// Timestamp 90 minutes before NOW — outside a 60-minute TTL.
const STALE = '2025-04-27T12:30:00Z';

function snap(
  base: string,
  quote: string,
  rate: string,
  overrides: Partial<FxSnapshot> = {},
): FxSnapshot {
  return {
    provider: 'OXR',
    baseCurrency: base,
    quoteCurrency: quote,
    rate,
    observedAt: FRESH,
    ...overrides,
  };
}

/** OXR free-plan config: USD pivot, hourly freshness. */
const OXR_CFG: FxConfig = {
  freshnessTtlMinutes: 60,
  pivotCurrency: 'USD',
  preferredProvider: 'OXR',
};

/** ECB config: EUR pivot, daily freshness. */
const ECB_CFG: FxConfig = {
  freshnessTtlMinutes: 1440,
  pivotCurrency: 'EUR',
  preferredProvider: 'ECB',
};

// ─── findFreshestSnapshot ─────────────────────────────────────────────────────

describe('findFreshestSnapshot', () => {
  it('returns a matching fresh snapshot', () => {
    const s = snap('USD', 'EUR', '0.92000000');
    const result = findFreshestSnapshot([s], 'OXR', 'USD', 'EUR', NOW, 60);
    expect(result).toBe(s);
  });

  it('returns undefined when the only match is stale', () => {
    const s = snap('USD', 'EUR', '0.92000000', { observedAt: STALE });
    const result = findFreshestSnapshot([s], 'OXR', 'USD', 'EUR', NOW, 60);
    expect(result).toBeUndefined();
  });

  it('returns undefined when no snapshot matches currencies', () => {
    const s = snap('USD', 'GBP', '0.78000000');
    const result = findFreshestSnapshot([s], 'OXR', 'USD', 'EUR', NOW, 60);
    expect(result).toBeUndefined();
  });

  it('returns undefined when provider does not match', () => {
    const s = snap('USD', 'EUR', '0.92000000', { provider: 'ECB' });
    const result = findFreshestSnapshot([s], 'OXR', 'USD', 'EUR', NOW, 60);
    expect(result).toBeUndefined();
  });

  it('returns the most recent of two valid snapshots', () => {
    const older = snap('USD', 'EUR', '0.91000000', { observedAt: '2025-04-27T13:00:00Z' });
    const newer = snap('USD', 'EUR', '0.92000000', { observedAt: '2025-04-27T13:30:00Z' });
    const result = findFreshestSnapshot([older, newer], 'OXR', 'USD', 'EUR', NOW, 60);
    expect(result).toBe(newer);
  });

  it('accepts any provider when provider param is undefined', () => {
    const oxr = snap('USD', 'EUR', '0.92000000', { provider: 'OXR' });
    const ecb = snap('USD', 'EUR', '0.91500000', { provider: 'ECB' });
    const result = findFreshestSnapshot([oxr, ecb], undefined, 'USD', 'EUR', NOW, 60);
    // Both match; the one with the later observedAt wins. They share FRESH, so
    // whichever appears first in array order will win (same timestamp → first best).
    expect(result).toBe(oxr);
  });
});

// ─── deriveCrossRate ──────────────────────────────────────────────────────────

describe('deriveCrossRate', () => {
  it('derives EUR→GBP rate via USD pivot', () => {
    // USD/EUR = 0.92, USD/GBP = 0.78
    // EUR/GBP = 0.78 / 0.92 ≈ 0.84782609
    const pivotToEur = snap('USD', 'EUR', '0.92000000');
    const pivotToGbp = snap('USD', 'GBP', '0.78000000');
    const result = deriveCrossRate(pivotToEur, pivotToGbp);
    expect(result.rate).toBe((0.78 / 0.92).toFixed(8));
    expect(result.pivotCurrency).toBe('USD');
    expect(result.provider).toBe('OXR');
  });

  it('uses the older observedAt as the effective rate timestamp', () => {
    const older = snap('USD', 'EUR', '0.92000000', { observedAt: '2025-04-27T13:00:00Z' });
    const newer = snap('USD', 'GBP', '0.78000000', { observedAt: '2025-04-27T13:30:00Z' });
    const result = deriveCrossRate(older, newer);
    expect(result.observedAt).toBe('2025-04-27T13:00:00Z');
  });

  it('symmetric: swapping from/to gives the reciprocal rate', () => {
    const pivotToEur = snap('USD', 'EUR', '0.92000000');
    const pivotToGbp = snap('USD', 'GBP', '0.78000000');
    const eurGbp = deriveCrossRate(pivotToEur, pivotToGbp);
    const gbpEur = deriveCrossRate(pivotToGbp, pivotToEur);
    expect(parseFloat(eurGbp.rate) * parseFloat(gbpEur.rate)).toBeCloseTo(1, 6);
  });
});

// ─── applyFx ─────────────────────────────────────────────────────────────────

describe('applyFx', () => {
  it('returns SAME_CURRENCY when source and target currencies match', () => {
    const result = applyFx({ amount: '100.00', currency: 'USD' }, 'USD', [], NOW, OXR_CFG);
    expect(result).toEqual({ converted: false, reason: 'SAME_CURRENCY' });
  });

  it('converts via DIRECT rate — USD→EUR', () => {
    const snapshots = [snap('USD', 'EUR', '0.92000000')];
    const result = applyFx({ amount: '100.00', currency: 'USD' }, 'EUR', snapshots, NOW, OXR_CFG);
    expect(result).toMatchObject({
      converted: true,
      method: 'DIRECT',
      appliedRate: '0.92000000',
      provider: 'OXR',
    });
    if (result.converted) {
      expect(result.displayAmount).toEqual({ amount: '92.00', currency: 'EUR' });
    }
  });

  it('converts via INVERSE rate — EUR→USD when only USD/EUR snapshot exists', () => {
    // USD/EUR = 0.92 → EUR/USD = 1/0.92 ≈ 1.08695652
    const snapshots = [snap('USD', 'EUR', '0.92000000')];
    const result = applyFx({ amount: '100.00', currency: 'EUR' }, 'USD', snapshots, NOW, OXR_CFG);
    expect(result).toMatchObject({ converted: true, method: 'INVERSE' });
    if (result.converted) {
      const expected = Math.round((100 / 0.92) * 100) / 100;
      expect(parseFloat(result.displayAmount.amount)).toBeCloseTo(expected, 1);
      expect(result.displayAmount.currency).toBe('USD');
    }
  });

  it('converts via CROSS_RATE — EUR→GBP via USD pivot', () => {
    const snapshots = [
      snap('USD', 'EUR', '0.92000000'),
      snap('USD', 'GBP', '0.78000000'),
    ];
    const result = applyFx({ amount: '100.00', currency: 'EUR' }, 'GBP', snapshots, NOW, OXR_CFG);
    expect(result).toMatchObject({
      converted: true,
      method: 'CROSS_RATE',
      pivotCurrency: 'USD',
    });
    if (result.converted) {
      // EUR/GBP = 0.78/0.92 ≈ 0.8478; 100 EUR ≈ 84.78 GBP
      expect(parseFloat(result.displayAmount.amount)).toBeCloseTo(84.78, 0);
      expect(result.displayAmount.currency).toBe('GBP');
    }
  });

  it('returns NO_RATE when no fresh snapshot exists', () => {
    const result = applyFx({ amount: '100.00', currency: 'EUR' }, 'GBP', [], NOW, OXR_CFG);
    expect(result).toEqual({ converted: false, reason: 'NO_RATE' });
  });

  it('returns NO_RATE when the only matching snapshot is stale', () => {
    const snapshots = [snap('USD', 'EUR', '0.92000000', { observedAt: STALE })];
    const result = applyFx({ amount: '100.00', currency: 'USD' }, 'EUR', snapshots, NOW, OXR_CFG);
    expect(result).toEqual({ converted: false, reason: 'NO_RATE' });
  });

  it('rounds correctly for zero-decimal currencies (JPY)', () => {
    // 100 USD * 150.25 (rate) = 15025 JPY — should be an integer
    const snapshots = [snap('USD', 'JPY', '150.25000000')];
    const result = applyFx({ amount: '100.00', currency: 'USD' }, 'JPY', snapshots, NOW, OXR_CFG);
    if (result.converted) {
      expect(result.displayAmount).toEqual({ amount: '15025', currency: 'JPY' });
    } else {
      expect.fail('Expected conversion to succeed');
    }
  });

  it('works with ECB EUR-pivot config via CROSS_RATE', () => {
    // ECB: EUR/USD = 1.085, EUR/GBP = 0.861
    // AED→GBP: EUR/AED = 3.98, EUR/GBP = 0.861
    // AED/GBP = 0.861 / 3.98 ≈ 0.2163
    const snapshots = [
      snap('EUR', 'AED', '3.98000000', { provider: 'ECB' }),
      snap('EUR', 'GBP', '0.86100000', { provider: 'ECB' }),
    ];
    const result = applyFx(
      { amount: '1000.00', currency: 'AED' },
      'GBP',
      snapshots,
      NOW,
      ECB_CFG,
    );
    expect(result).toMatchObject({ converted: true, method: 'CROSS_RATE', pivotCurrency: 'EUR' });
    if (result.converted) {
      expect(parseFloat(result.displayAmount.amount)).toBeCloseTo(216.33, 0);
      expect(result.displayAmount.currency).toBe('GBP');
    }
  });

  it('prefers DIRECT over INVERSE and CROSS_RATE when all are available', () => {
    const snapshots = [
      snap('EUR', 'USD', '1.08500000'),  // direct EUR→USD
      snap('USD', 'EUR', '0.92000000'),  // would give INVERSE EUR→USD
    ];
    const result = applyFx(
      { amount: '100.00', currency: 'EUR' },
      'USD',
      snapshots,
      NOW,
      OXR_CFG,
    );
    expect(result).toMatchObject({ converted: true, method: 'DIRECT', appliedRate: '1.08500000' });
  });
});
