import { describe, expect, it } from 'vitest';
import type {
  DisplayPriceApplied,
  Money,
  SearchResultHotel,
  SearchResultRate,
} from '@bb/domain';
import {
  buildDisplayFx,
  type DisplayFxConverter,
} from '../display-fx';
import type { FxRateConversion } from '../../fx/fx-rate.service';

/**
 * Pure unit tests for the display-FX orchestrator. No DB, no Nest, no
 * network — just the helper, a hand-rolled converter, and assertions
 * against the resulting hotels + meta + audit-row inputs.
 */

const SEARCH_ID = '01ARZ3NDEKTSV4RRFFQ69G5SEARCH';

function rate(
  supplierRateId: string,
  amount: string,
  currency: string,
): SearchResultRate {
  return {
    supplierRateId,
    roomType: 'STD',
    ratePlan: 'BAR',
    priceQuote: {
      netCost: { amount, currency },
      sellingPrice: { amount, currency },
    },
    trace: { steps: [], finalSellAmount: { amount, currency } },
    moneyMovementProvenance: 'CONFIG_RESOLVED',
    isBookable: true,
    offerShape: 'SOURCED_COMPOSED',
    rateBreakdownGranularity: 'TOTAL',
    supplierRawRef: 'ref',
  };
}

function hotel(rates: SearchResultRate[]): SearchResultHotel {
  return {
    supplierId: 'hotelbeds',
    supplierHotelCode: '1000073',
    rates,
  };
}

/**
 * Trivial converter that maps `(source, target)` to a fixed conversion.
 * Lets each test choose exactly which conversions succeed or fail.
 */
function makeConverter(
  table: Record<string, FxRateConversion>,
): DisplayFxConverter {
  return {
    convert(source: Money, target: string): FxRateConversion {
      if (source.currency === target) {
        return { converted: false, reason: 'SAME_CURRENCY' };
      }
      const key = `${source.currency}->${target}`;
      return (
        table[key] ?? { converted: false, reason: 'NO_RATE' }
      );
    },
  };
}

function direct(
  amount: string,
  currency: string,
  appliedRate: string,
  provider: 'OXR' | 'ECB',
  snapshotId: string,
): FxRateConversion {
  return {
    converted: true,
    displayAmount: { amount, currency },
    appliedRate,
    provider,
    method: 'DIRECT',
    observedAt: '2026-04-27T13:30:00Z',
    snapshotIds: [snapshotId],
  };
}

function crossRate(
  amount: string,
  currency: string,
  appliedRate: string,
  provider: 'OXR' | 'ECB',
  pivot: string,
  snapshotIds: string[],
): FxRateConversion {
  return {
    converted: true,
    displayAmount: { amount, currency },
    appliedRate,
    provider,
    method: 'CROSS_RATE',
    pivotCurrency: pivot,
    observedAt: '2026-04-27T13:30:00Z',
    snapshotIds,
  };
}

describe('buildDisplayFx', () => {
  it('attaches displayPrice on every rate and reports APPLIED when all conversions succeed', () => {
    const results = [
      hotel([rate('r1', '100.00', 'USD'), rate('r2', '200.00', 'USD')]),
    ];
    const converter = makeConverter({
      'USD->EUR': direct('92.00', 'EUR', '0.92000000', 'OXR', 'snap-1'),
    });

    const out = buildDisplayFx({
      results,
      displayCurrency: 'EUR',
      searchId: SEARCH_ID,
      converter,
    });

    expect(out.meta.status).toBe('APPLIED');
    expect(out.meta.providers).toEqual(['OXR']);
    expect(out.meta.ratesNeedingConversion).toBe(2);
    expect(out.meta.ratesConverted).toBe(2);

    const dp1 = out.results[0]!.rates[0]!.displayPrice as DisplayPriceApplied;
    expect(dp1.amount).toEqual({ amount: '92.00', currency: 'EUR' });
    expect(dp1.method).toBe('DIRECT');
    expect(dp1.provider).toBe('OXR');

    // Dedup: 2 rates with the same source-currency / snapshot collapse to 1 audit row.
    expect(out.applications).toHaveLength(1);
    expect(out.applications[0]).toMatchObject({
      sourceCurrency: 'USD',
      displayCurrency: 'EUR',
      rateSnapshotId: 'snap-1',
      provider: 'OXR',
      applicationKind: 'SEARCH',
      requestCorrelationRef: SEARCH_ID,
    });
  });

  it('skips same-currency rates (no displayPrice) and still reports APPLIED', () => {
    const results = [hotel([rate('r1', '100.00', 'EUR')])];
    const out = buildDisplayFx({
      results,
      displayCurrency: 'EUR',
      searchId: SEARCH_ID,
      converter: makeConverter({}),
    });
    expect(out.meta.status).toBe('APPLIED');
    expect(out.meta.ratesNeedingConversion).toBe(0);
    expect(out.meta.ratesConverted).toBe(0);
    expect(out.results[0]!.rates[0]!.displayPrice).toBeUndefined();
    expect(out.applications).toHaveLength(0);
  });

  it('reports DEGRADED when no rate could be converted', () => {
    const results = [
      hotel([rate('r1', '100.00', 'JPY'), rate('r2', '200.00', 'JPY')]),
    ];
    const out = buildDisplayFx({
      results,
      displayCurrency: 'TRY',
      searchId: SEARCH_ID,
      converter: makeConverter({}),
    });
    expect(out.meta.status).toBe('DEGRADED');
    expect(out.meta.providers).toEqual([]);
    expect(out.meta.ratesNeedingConversion).toBe(2);
    expect(out.meta.ratesConverted).toBe(0);
    expect(out.results[0]!.rates.every((r) => r.displayPrice === undefined)).toBe(true);
    expect(out.applications).toHaveLength(0);
  });

  it('reports PARTIAL when only some rates convert', () => {
    const results = [
      hotel([rate('r1', '100.00', 'USD'), rate('r2', '200.00', 'JPY')]),
    ];
    const converter = makeConverter({
      'USD->EUR': direct('92.00', 'EUR', '0.92000000', 'OXR', 'snap-usd'),
      // JPY→EUR not in table → NO_RATE
    });
    const out = buildDisplayFx({
      results,
      displayCurrency: 'EUR',
      searchId: SEARCH_ID,
      converter,
    });
    expect(out.meta.status).toBe('PARTIAL');
    expect(out.meta.providers).toEqual(['OXR']);
    expect(out.meta.ratesNeedingConversion).toBe(2);
    expect(out.meta.ratesConverted).toBe(1);

    expect(out.results[0]!.rates[0]!.displayPrice).toBeDefined();
    expect(out.results[0]!.rates[1]!.displayPrice).toBeUndefined();
    expect(out.applications).toHaveLength(1);
  });

  it('reports both providers when OXR + ECB both fired across rates', () => {
    const results = [
      hotel([rate('r1', '100.00', 'USD'), rate('r2', '200.00', 'AED')]),
    ];
    const converter = makeConverter({
      'USD->EUR': direct('92.00', 'EUR', '0.92000000', 'OXR', 'snap-oxr'),
      'AED->EUR': direct('48.00', 'EUR', '0.24000000', 'ECB', 'snap-ecb'),
    });
    const out = buildDisplayFx({
      results,
      displayCurrency: 'EUR',
      searchId: SEARCH_ID,
      converter,
    });
    expect(out.meta.status).toBe('APPLIED');
    expect(out.meta.providers).toEqual(['ECB', 'OXR']); // sorted
    expect(out.applications).toHaveLength(2);
  });

  it('attaches displayPrice for CROSS_RATE but skips its audit row (single-snapshot schema constraint)', () => {
    const results = [hotel([rate('r1', '100.00', 'EUR')])];
    const converter = makeConverter({
      'EUR->GBP': crossRate(
        '84.78',
        'GBP',
        '0.84782609',
        'OXR',
        'USD',
        ['snap-pivot-eur', 'snap-pivot-gbp'],
      ),
    });
    const out = buildDisplayFx({
      results,
      displayCurrency: 'GBP',
      searchId: SEARCH_ID,
      converter,
    });
    expect(out.meta.status).toBe('APPLIED');
    expect(out.meta.ratesConverted).toBe(1);
    const dp = out.results[0]!.rates[0]!.displayPrice as DisplayPriceApplied;
    expect(dp.method).toBe('CROSS_RATE');
    expect(dp.pivotCurrency).toBe('USD');
    // Audit-row gap: CROSS_RATE deferred until schema supports two snapshots.
    expect(out.applications).toHaveLength(0);
  });

  it('deduplicates audit rows on (source_currency, rate_snapshot_id) per request', () => {
    const results = [
      hotel([
        rate('r1', '100.00', 'USD'),
        rate('r2', '150.00', 'USD'),
        rate('r3', '50.00', 'CHF'),
      ]),
    ];
    const converter = makeConverter({
      'USD->EUR': direct('92.00', 'EUR', '0.92000000', 'OXR', 'snap-usd'),
      'CHF->EUR': direct('45.50', 'EUR', '0.91000000', 'OXR', 'snap-chf'),
    });
    const out = buildDisplayFx({
      results,
      displayCurrency: 'EUR',
      searchId: SEARCH_ID,
      converter,
    });
    // Two USD rates → one audit row; one CHF rate → one audit row. Total: 2.
    expect(out.applications).toHaveLength(2);
    const sources = out.applications.map((a) => a.sourceCurrency).sort();
    expect(sources).toEqual(['CHF', 'USD']);
  });

  it('does not mutate the input hotel/rate objects', () => {
    const r = rate('r1', '100.00', 'USD');
    const h = hotel([r]);
    const converter = makeConverter({
      'USD->EUR': direct('92.00', 'EUR', '0.92000000', 'OXR', 'snap-1'),
    });
    buildDisplayFx({
      results: [h],
      displayCurrency: 'EUR',
      searchId: SEARCH_ID,
      converter,
    });
    expect(r).not.toHaveProperty('displayPrice');
    expect(h.rates[0]).toBe(r);
  });
});
