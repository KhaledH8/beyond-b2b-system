import { describe, expect, it } from 'vitest';
import type { AccountContext, MarkupRuleSnapshot } from '@bb/domain';
import { evaluateSourcedOffer, pickRule } from './evaluator';
import { applyPercentMarkup, fromMinorUnits, toMinorUnits } from './money';

const TENANT = 'TNT0000000000000000000001';
const ACCOUNT = 'ACC0000000000000000000001';
const HOTEL = 'HSP0000000000000000000001';

const ctx: AccountContext = {
  tenantId: TENANT,
  accountId: ACCOUNT,
  accountType: 'AGENCY',
};

function offer(overrides: Partial<{ amount: string; currency: string; hotel: string }> = {}) {
  const amount = overrides.amount ?? '100.00';
  const currency = overrides.currency ?? 'EUR';
  return {
    supplierHotelId: overrides.hotel ?? HOTEL,
    netAmountMinorUnits: toMinorUnits(amount, currency),
    currency,
  };
}

function rule(
  partial: Partial<MarkupRuleSnapshot> & {
    scope: MarkupRuleSnapshot['scope'];
    id: string;
    percentValue: string;
  },
): MarkupRuleSnapshot {
  return {
    tenantId: TENANT,
    markupKind: 'PERCENT',
    priority: 0,
    ...partial,
  };
}

describe('money helpers', () => {
  it('round-trips decimal strings via minor units', () => {
    expect(fromMinorUnits(toMinorUnits('120.50', 'EUR'), 'EUR')).toBe('120.50');
    expect(fromMinorUnits(toMinorUnits('1.99', 'USD'), 'USD')).toBe('1.99');
    expect(fromMinorUnits(toMinorUnits('1500', 'JPY'), 'JPY')).toBe('1500');
  });

  it('applies percent markup half-away-from-zero', () => {
    // 10% of 100.50 = 10.05 (half rounds away)
    expect(applyPercentMarkup(toMinorUnits('100.50', 'EUR'), '10.0000')).toBe(
      1005n,
    );
    // 12.5% of 200.00 = 25.00
    expect(applyPercentMarkup(toMinorUnits('200.00', 'EUR'), '12.5000')).toBe(
      2500n,
    );
    // sub-percent precision
    expect(
      applyPercentMarkup(toMinorUnits('100.00', 'EUR'), '0.5000'),
    ).toBe(50n);
  });

  it('rejects malformed numeric strings', () => {
    expect(() => toMinorUnits('abc', 'EUR')).toThrow();
    expect(() => applyPercentMarkup(0n, 'NaN')).toThrow();
  });
});

describe('evaluateSourcedOffer · no rule', () => {
  it('returns net == sell when no rules match', () => {
    const result = evaluateSourcedOffer(offer(), [], ctx);
    expect(result.priceQuote.sellingPrice.amount).toBe('100.00');
    expect(result.priceQuote.netCost.amount).toBe('100.00');
    expect(result.priceQuote.appliedMarkup).toBeUndefined();
    expect(result.trace.steps.length).toBe(1);
    expect(result.trace.steps[0]!.kind).toBe('NET_COST');
  });
});

describe('evaluateSourcedOffer · channel default fires', () => {
  it('applies CHANNEL rule when no ACCOUNT or HOTEL match', () => {
    const r = rule({
      id: 'R-CHANNEL',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '10.0000',
    });
    const result = evaluateSourcedOffer(offer({ amount: '100.00' }), [r], ctx);
    expect(result.priceQuote.sellingPrice.amount).toBe('110.00');
    expect(result.priceQuote.appliedMarkup?.ruleId).toBe('R-CHANNEL');
    expect(result.priceQuote.appliedMarkup?.scope).toBe('CHANNEL');
    expect(result.priceQuote.appliedMarkup?.markupAmount.amount).toBe('10.00');
  });
});

describe('evaluateSourcedOffer · precedence', () => {
  it('ACCOUNT wins over HOTEL and CHANNEL even with lower priority', () => {
    const channel = rule({
      id: 'R-CHANNEL',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '10.0000',
      priority: 100,
    });
    const hotel = rule({
      id: 'R-HOTEL',
      scope: 'HOTEL',
      supplierHotelId: HOTEL,
      percentValue: '15.0000',
      priority: 50,
    });
    const account = rule({
      id: 'R-ACCOUNT',
      scope: 'ACCOUNT',
      accountId: ACCOUNT,
      percentValue: '5.0000',
      priority: 0, // explicitly low — scope precedence still wins
    });

    const result = evaluateSourcedOffer(
      offer({ amount: '100.00' }),
      [channel, hotel, account],
      ctx,
    );
    expect(result.priceQuote.appliedMarkup?.ruleId).toBe('R-ACCOUNT');
    expect(result.priceQuote.sellingPrice.amount).toBe('105.00');
  });

  it('HOTEL wins over CHANNEL when no ACCOUNT match', () => {
    const channel = rule({
      id: 'R-CHANNEL',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '10.0000',
    });
    const hotel = rule({
      id: 'R-HOTEL',
      scope: 'HOTEL',
      supplierHotelId: HOTEL,
      percentValue: '15.0000',
    });

    const result = evaluateSourcedOffer(
      offer({ amount: '100.00' }),
      [channel, hotel],
      ctx,
    );
    expect(result.priceQuote.appliedMarkup?.ruleId).toBe('R-HOTEL');
    expect(result.priceQuote.sellingPrice.amount).toBe('115.00');
  });

  it('within scope, higher priority wins; ties broken by id', () => {
    const lowPriority = rule({
      id: 'R-CHANNEL-A',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '10.0000',
      priority: 1,
    });
    const highPriority = rule({
      id: 'R-CHANNEL-B',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '20.0000',
      priority: 5,
    });

    const result = evaluateSourcedOffer(
      offer({ amount: '100.00' }),
      [lowPriority, highPriority],
      ctx,
    );
    expect(result.priceQuote.appliedMarkup?.ruleId).toBe('R-CHANNEL-B');
    expect(result.priceQuote.sellingPrice.amount).toBe('120.00');
  });
});

describe('evaluateSourcedOffer · multi-tenant isolation', () => {
  it('rejects rules from another tenant even if other fields match', () => {
    const otherTenant = rule({
      id: 'R-OTHER',
      scope: 'ACCOUNT',
      accountId: ACCOUNT,
      percentValue: '50.0000',
    });
    // Override tenantId to a different value.
    const cross: MarkupRuleSnapshot = { ...otherTenant, tenantId: 'TNT-OTHER' };
    const result = evaluateSourcedOffer(offer(), [cross], ctx);
    expect(result.priceQuote.appliedMarkup).toBeUndefined();
    expect(result.priceQuote.sellingPrice.amount).toBe('100.00');
  });
});

describe('pickRule · unknown kinds are skipped', () => {
  it('falls through to the next applicable rule', () => {
    const unknownKind: MarkupRuleSnapshot = {
      ...rule({
        id: 'R-FUTURE',
        scope: 'ACCOUNT',
        accountId: ACCOUNT,
        percentValue: '0',
      }),
      // Cast through unknown to simulate a future kind value the
      // evaluator does not support yet.
      markupKind: 'FIXED' as unknown as 'PERCENT',
    };
    const fallback = rule({
      id: 'R-CHANNEL',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '10.0000',
    });
    const winner = pickRule([unknownKind, fallback], ctx, HOTEL);
    expect(winner?.id).toBe('R-CHANNEL');
  });
});
