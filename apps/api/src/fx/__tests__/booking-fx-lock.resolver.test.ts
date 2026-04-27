import { describe, expect, it, vi } from 'vitest';
import { BookingFxLockResolver } from '../booking-fx-lock.resolver';
import type { StripeFxQuoteClient } from '../stripe-fx-quote.client';
import type { FxRateService, FxRateConversion } from '../fx-rate.service';

/**
 * Pure unit tests for the booking-time FX lock decision tree.
 * Stripe and FxRateService are mocked. The resolver is the gatekeeper
 * that enforces "ECB never used for booking-time fallback" — that
 * invariant is verified by the test that confirms `loadOxrOnlyConverter`
 * (not `loadConverter`) is the method called.
 */

const NOW = new Date('2026-04-28T10:00:00Z');

interface StripeMock {
  client: StripeFxQuoteClient;
  fetchQuote: ReturnType<typeof vi.fn>;
}

interface FxRateMock {
  service: FxRateService;
  loadOxrOnlyConverter: ReturnType<typeof vi.fn>;
  loadConverter: ReturnType<typeof vi.fn>;
  convert: ReturnType<typeof vi.fn>;
}

function makeStripeMock(impl: () => Promise<unknown>): StripeMock {
  const fetchQuote = vi.fn(impl);
  return {
    client: { fetchQuote } as unknown as StripeFxQuoteClient,
    fetchQuote,
  };
}

function makeFxRateMock(convertImpl: () => FxRateConversion): FxRateMock {
  const convert = vi.fn(convertImpl);
  const converter = { convert };
  const loadOxrOnlyConverter = vi.fn(async () => converter);
  const loadConverter = vi.fn(async () => converter);
  return {
    service: { loadOxrOnlyConverter, loadConverter } as unknown as FxRateService,
    loadOxrOnlyConverter,
    loadConverter,
    convert,
  };
}

describe('BookingFxLockResolver', () => {
  it('returns NO_LOCK_NEEDED when source and charge currencies match', async () => {
    const stripe = makeStripeMock(async () => {
      throw new Error('should not be called');
    });
    const fx = makeFxRateMock(() => {
      throw new Error('should not be called');
    });
    const resolver = new BookingFxLockResolver(stripe.client, fx.service);

    const decision = await resolver.resolve({
      sourceCurrency: 'USD',
      chargeCurrency: 'USD',
      sourceMinor: 10000n,
      asOf: NOW,
    });

    expect(decision).toEqual({
      kind: 'NO_LOCK_NEEDED',
      reason: 'SAME_CURRENCY',
    });
    expect(stripe.fetchQuote).not.toHaveBeenCalled();
    expect(fx.loadOxrOnlyConverter).not.toHaveBeenCalled();
  });

  it('returns STRIPE_FX_QUOTE when Stripe succeeds, inverting the wire rate', async () => {
    const stripe = makeStripeMock(async () => ({
      id: 'fxq_test',
      lockExpiresAt: '2026-04-28T11:00:00Z',
      lockStatus: 'active',
      fromCurrency: 'GBP',
      toCurrency: 'USD',
      // Stripe wire rate semantics: 1 from(charge=GBP) = 1.282 to(source=USD)
      // Our schema rate (1 source = N charge) = 1/1.282 ≈ 0.78003120
      exchangeRate: '1.28200000',
    }));
    const fx = makeFxRateMock(() => ({
      converted: false,
      reason: 'NO_RATE',
    }));
    const resolver = new BookingFxLockResolver(stripe.client, fx.service);

    const decision = await resolver.resolve({
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      asOf: NOW,
    });

    expect(decision.kind).toBe('STRIPE_FX_QUOTE');
    if (decision.kind === 'STRIPE_FX_QUOTE') {
      expect(decision.provider).toBe('STRIPE');
      expect(decision.providerQuoteId).toBe('fxq_test');
      expect(decision.expiresAt).toBe('2026-04-28T11:00:00Z');
      expect(decision.rate).toBe('0.78003120');
      // 10000 USD minor × (1/1.282) = 7800.31 → round to 7800
      expect(decision.chargeMinor).toBe(7800n);
      expect(decision.sourceMinor).toBe(10000n);
    }
    expect(stripe.fetchQuote).toHaveBeenCalledWith({
      fromCurrency: 'GBP',
      toCurrency: 'USD',
    });
    // OXR fallback never consulted on Stripe success.
    expect(fx.loadOxrOnlyConverter).not.toHaveBeenCalled();
  });

  it('falls back to OXR SNAPSHOT_REFERENCE when Stripe fails and OXR has a fresh DIRECT snapshot', async () => {
    const stripe = makeStripeMock(async () => {
      throw new Error('stripe down');
    });
    const fx = makeFxRateMock(() => ({
      converted: true,
      method: 'DIRECT',
      provider: 'OXR',
      appliedRate: '0.78000000',
      observedAt: '2026-04-28T09:30:00Z',
      displayAmount: { amount: '0.78', currency: 'GBP' },
      snapshotIds: ['snap-oxr-1'],
    }));
    const resolver = new BookingFxLockResolver(stripe.client, fx.service);

    const decision = await resolver.resolve({
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      asOf: NOW,
    });

    expect(decision.kind).toBe('SNAPSHOT_REFERENCE');
    if (decision.kind === 'SNAPSHOT_REFERENCE') {
      expect(decision.provider).toBe('OXR');
      expect(decision.rateSnapshotId).toBe('snap-oxr-1');
      expect(decision.rate).toBe('0.78000000');
      // 10000 × 0.78 = 7800 GBP minor
      expect(decision.chargeMinor).toBe(7800n);
    }
    // ECB exclusion: the resolver must use loadOxrOnlyConverter, never loadConverter.
    expect(fx.loadOxrOnlyConverter).toHaveBeenCalledTimes(1);
    expect(fx.loadConverter).not.toHaveBeenCalled();
  });

  it('returns NO_LOCK_AVAILABLE when Stripe fails and OXR has no fresh snapshot', async () => {
    const stripe = makeStripeMock(async () => {
      throw new Error('stripe down');
    });
    const fx = makeFxRateMock(() => ({
      converted: false,
      reason: 'NO_RATE',
    }));
    const resolver = new BookingFxLockResolver(stripe.client, fx.service);

    const decision = await resolver.resolve({
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      asOf: NOW,
    });

    expect(decision.kind).toBe('NO_LOCK_AVAILABLE');
    if (decision.kind === 'NO_LOCK_AVAILABLE') {
      expect(decision.reason).toBe('STRIPE_FAILED_AND_NO_OXR_SNAPSHOT');
      expect(decision.stripeError).toContain('stripe down');
    }
    expect(fx.loadOxrOnlyConverter).toHaveBeenCalledTimes(1);
    expect(fx.loadConverter).not.toHaveBeenCalled();
  });

  it('treats OXR CROSS_RATE (multi-snapshot) result as NO_LOCK_AVAILABLE for booking-time lock', async () => {
    // CROSS_RATE returns 2 snapshot ids, but `booking_fx_lock.rate_snapshot_id`
    // is single-valued. C5b refuses to attribute the row to one of two legs;
    // the booking still confirms in source currency (no row written).
    const stripe = makeStripeMock(async () => {
      throw new Error('stripe down');
    });
    const fx = makeFxRateMock(() => ({
      converted: true,
      method: 'CROSS_RATE',
      provider: 'OXR',
      pivotCurrency: 'USD',
      appliedRate: '0.84782609',
      observedAt: '2026-04-28T09:30:00Z',
      displayAmount: { amount: '0.84', currency: 'GBP' },
      snapshotIds: ['snap-oxr-pivot-eur', 'snap-oxr-pivot-gbp'],
    }));
    const resolver = new BookingFxLockResolver(stripe.client, fx.service);

    const decision = await resolver.resolve({
      sourceCurrency: 'EUR',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      asOf: NOW,
    });

    expect(decision.kind).toBe('NO_LOCK_AVAILABLE');
  });

  it('does not consult ECB even when only ECB has data (proves ECB exclusion)', async () => {
    // Simulate: OXR-only loader returns empty (no OXR snapshots), so the
    // resolver must end at NO_LOCK_AVAILABLE — even if a hypothetical
    // ECB tier could have served the pair. Confirms loadConverter is
    // never called.
    const stripe = makeStripeMock(async () => {
      throw new Error('stripe down');
    });
    const fx = makeFxRateMock(() => ({
      converted: false,
      reason: 'NO_RATE',
    }));
    const resolver = new BookingFxLockResolver(stripe.client, fx.service);

    const decision = await resolver.resolve({
      sourceCurrency: 'USD',
      chargeCurrency: 'JPY',
      sourceMinor: 10000n,
      asOf: NOW,
    });

    expect(decision.kind).toBe('NO_LOCK_AVAILABLE');
    expect(fx.loadOxrOnlyConverter).toHaveBeenCalledTimes(1);
    expect(fx.loadConverter).not.toHaveBeenCalled();
  });

  it('rounds half-away-from-zero on the chargeMinor calculation', async () => {
    // Crafted: rate 0.99999999 × 1000 minor = 999.99999 → rounds to 1000.
    const stripe = makeStripeMock(async () => ({
      id: 'fxq_a',
      lockExpiresAt: '2026-04-28T11:00:00Z',
      lockStatus: 'active',
      fromCurrency: 'GBP',
      toCurrency: 'USD',
      exchangeRate: '1.00000001', // ourRate ≈ 0.99999999
    }));
    const fx = makeFxRateMock(() => ({
      converted: false,
      reason: 'NO_RATE',
    }));
    const resolver = new BookingFxLockResolver(stripe.client, fx.service);

    const decision = await resolver.resolve({
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 1000n,
      asOf: NOW,
    });

    expect(decision.kind).toBe('STRIPE_FX_QUOTE');
    if (decision.kind === 'STRIPE_FX_QUOTE') {
      // 1000 × 0.99999999 = 999.99999 → 1000 (half-away rounding)
      expect(decision.chargeMinor).toBe(1000n);
    }
  });
});
