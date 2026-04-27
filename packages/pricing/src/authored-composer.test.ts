import { describe, expect, it } from 'vitest';
import type { AccountContext, MarkupRuleSnapshot } from '@bb/domain';
import {
  AUTHORED_OFFER_SHAPE,
  evaluateAuthoredOffer,
  type AuthoredNightLine,
  type PriceableAuthoredOffer,
} from './authored-composer';

const TENANT = 'TNT0000000000000000000001';
const ACCOUNT = 'ACC0000000000000000000001';
const HOTEL = 'HSP0000000000000000000001';

const ctx: AccountContext = {
  tenantId: TENANT,
  accountId: ACCOUNT,
  accountType: 'AGENCY',
};

function night(
  stayDate: string,
  base: bigint = 10000n,
  occ: bigint = 0n,
  meal: bigint = 0n,
): AuthoredNightLine {
  return {
    stayDate,
    baseRateMinorUnits: base,
    occupancySupplementMinorUnits: occ,
    mealSupplementMinorUnits: meal,
  };
}

function offer(
  partial: Partial<PriceableAuthoredOffer> = {},
): PriceableAuthoredOffer {
  return {
    supplierHotelId: HOTEL,
    currency: 'EUR',
    checkIn: '2026-06-01',
    checkOut: '2026-06-04',
    nights: [
      night('2026-06-01'),
      night('2026-06-02'),
      night('2026-06-03'),
    ],
    ...partial,
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

describe('AUTHORED_OFFER_SHAPE constant', () => {
  it('is the canonical literal "AUTHORED_PRIMITIVES" (ADR-021)', () => {
    expect(AUTHORED_OFFER_SHAPE).toBe('AUTHORED_PRIMITIVES');
  });
});

describe('evaluateAuthoredOffer · base only, no rules', () => {
  it('returns net == sell with a single AUTHORED_BASE_RATE step', () => {
    const result = evaluateAuthoredOffer(offer(), [], ctx);
    expect(result.priceQuote.netCost.amount).toBe('300.00');
    expect(result.priceQuote.sellingPrice.amount).toBe('300.00');
    expect(result.priceQuote.appliedMarkup).toBeUndefined();
    expect(result.trace.steps).toHaveLength(1);
    expect(result.trace.steps[0]!.kind).toBe('AUTHORED_BASE_RATE');
    expect(result.trace.steps[0]!.before.amount).toBe('0.00');
    expect(result.trace.steps[0]!.after.amount).toBe('300.00');
    expect(result.trace.finalSellAmount.amount).toBe('300.00');
  });
});

describe('evaluateAuthoredOffer · supplements', () => {
  it('chains AUTHORED_BASE_RATE → OCCUPANCY → MEAL with cumulative before/after', () => {
    const result = evaluateAuthoredOffer(
      offer({
        nights: [
          night('2026-06-01', 10000n, 2500n, 1500n),
          night('2026-06-02', 10000n, 2500n, 1500n),
          night('2026-06-03', 10000n, 2500n, 1500n),
        ],
      }),
      [],
      ctx,
    );
    expect(result.trace.steps.map((s) => s.kind)).toEqual([
      'AUTHORED_BASE_RATE',
      'AUTHORED_OCCUPANCY_SUPPLEMENT',
      'AUTHORED_MEAL_SUPPLEMENT',
    ]);
    expect(result.trace.steps[0]!.before.amount).toBe('0.00');
    expect(result.trace.steps[0]!.after.amount).toBe('300.00');
    expect(result.trace.steps[1]!.before.amount).toBe('300.00');
    expect(result.trace.steps[1]!.after.amount).toBe('375.00');
    expect(result.trace.steps[2]!.before.amount).toBe('375.00');
    expect(result.trace.steps[2]!.after.amount).toBe('420.00');
    expect(result.priceQuote.netCost.amount).toBe('420.00');
    expect(result.priceQuote.sellingPrice.amount).toBe('420.00');
  });

  it('omits supplement steps when their per-stay totals are zero', () => {
    const result = evaluateAuthoredOffer(offer(), [], ctx);
    expect(result.trace.steps.map((s) => s.kind)).toEqual([
      'AUTHORED_BASE_RATE',
    ]);
  });

  it('emits OCCUPANCY but not MEAL when only the occupancy total is non-zero', () => {
    const result = evaluateAuthoredOffer(
      offer({
        nights: [
          night('2026-06-01', 10000n, 1000n),
          night('2026-06-02', 10000n, 1000n),
          night('2026-06-03', 10000n, 1000n),
        ],
      }),
      [],
      ctx,
    );
    expect(result.trace.steps.map((s) => s.kind)).toEqual([
      'AUTHORED_BASE_RATE',
      'AUTHORED_OCCUPANCY_SUPPLEMENT',
    ]);
    expect(result.priceQuote.netCost.amount).toBe('330.00');
  });
});

describe('evaluateAuthoredOffer · markup', () => {
  it('applies CHANNEL markup using the shared pickRule precedence', () => {
    const r = rule({
      id: 'R-CHANNEL',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '10.0000',
    });
    const result = evaluateAuthoredOffer(offer(), [r], ctx);
    expect(result.priceQuote.netCost.amount).toBe('300.00');
    expect(result.priceQuote.sellingPrice.amount).toBe('330.00');
    expect(result.priceQuote.appliedMarkup?.ruleId).toBe('R-CHANNEL');
    expect(result.priceQuote.appliedMarkup?.scope).toBe('CHANNEL');
    expect(result.priceQuote.appliedMarkup?.markupAmount.amount).toBe('30.00');
    const last = result.trace.steps[result.trace.steps.length - 1]!;
    expect(last.kind).toBe('MARKUP_APPLIED');
    expect(last.ruleId).toBe('R-CHANNEL');
    expect(last.before.amount).toBe('300.00');
    expect(last.after.amount).toBe('330.00');
  });

  it('ACCOUNT scope wins over HOTEL even with low priority', () => {
    const account = rule({
      id: 'R-ACCOUNT',
      scope: 'ACCOUNT',
      accountId: ACCOUNT,
      percentValue: '5.0000',
      priority: 0,
    });
    const hotel = rule({
      id: 'R-HOTEL',
      scope: 'HOTEL',
      supplierHotelId: HOTEL,
      percentValue: '15.0000',
      priority: 100,
    });
    const result = evaluateAuthoredOffer(offer(), [hotel, account], ctx);
    expect(result.priceQuote.appliedMarkup?.ruleId).toBe('R-ACCOUNT');
    expect(result.priceQuote.sellingPrice.amount).toBe('315.00');
  });

  it('rejects rules from another tenant even if other fields match', () => {
    const cross = rule({
      id: 'R-OTHER',
      scope: 'ACCOUNT',
      accountId: ACCOUNT,
      percentValue: '50.0000',
      tenantId: 'TNT-OTHER',
    });
    const result = evaluateAuthoredOffer(offer(), [cross], ctx);
    expect(result.priceQuote.appliedMarkup).toBeUndefined();
    expect(result.priceQuote.sellingPrice.amount).toBe('300.00');
  });
});

describe('evaluateAuthoredOffer · COLLECTION_AND_SETTLEMENT_BIND', () => {
  it('inserts the bind step after the authored chain when moneyMovement is present', () => {
    const r = rule({
      id: 'R-CHANNEL',
      scope: 'CHANNEL',
      accountType: 'AGENCY',
      percentValue: '10.0000',
    });
    const result = evaluateAuthoredOffer(
      offer({
        moneyMovement: {
          collectionMode: 'BB_COLLECTS',
          supplierSettlementMode: 'PREPAID_BALANCE',
          paymentCostModel: 'PLATFORM_CARD_FEE',
        },
        grossCurrencySemantics: 'NET_TO_BB',
      }),
      [r],
      ctx,
    );
    expect(result.trace.steps.map((s) => s.kind)).toEqual([
      'AUTHORED_BASE_RATE',
      'COLLECTION_AND_SETTLEMENT_BIND',
      'MARKUP_APPLIED',
    ]);
    const bind = result.trace.steps[1]!;
    expect(bind.before.amount).toBe('300.00');
    expect(bind.after.amount).toBe('300.00');
    expect(bind.collectionMode).toBe('BB_COLLECTS');
    expect(bind.supplierSettlementMode).toBe('PREPAID_BALANCE');
    expect(bind.paymentCostModel).toBe('PLATFORM_CARD_FEE');
    expect(bind.grossCurrencySemantics).toBe('NET_TO_BB');
    expect(result.priceQuote.sellingPrice.amount).toBe('330.00');
  });

  it('omits the bind step when moneyMovement is absent', () => {
    const result = evaluateAuthoredOffer(offer(), [], ctx);
    expect(
      result.trace.steps.find((s) => s.kind === 'COLLECTION_AND_SETTLEMENT_BIND'),
    ).toBeUndefined();
  });
});

describe('evaluateAuthoredOffer · validation', () => {
  it('rejects an empty nights array', () => {
    expect(() => evaluateAuthoredOffer(offer({ nights: [] }), [], ctx)).toThrow(
      /at least one/,
    );
  });

  it('rejects checkOut <= checkIn', () => {
    expect(() =>
      evaluateAuthoredOffer(
        offer({
          checkIn: '2026-06-04',
          checkOut: '2026-06-01',
          nights: [night('2026-06-04')],
        }),
        [],
        ctx,
      ),
    ).toThrow(/strictly after/);
  });

  it('rejects nights count mismatch with stay length', () => {
    expect(() =>
      evaluateAuthoredOffer(
        offer({
          checkIn: '2026-06-01',
          checkOut: '2026-06-04',
          nights: [night('2026-06-01'), night('2026-06-02')],
        }),
        [],
        ctx,
      ),
    ).toThrow(/does not match stay length/);
  });

  it('rejects non-contiguous nightly coverage', () => {
    expect(() =>
      evaluateAuthoredOffer(
        offer({
          nights: [
            night('2026-06-01'),
            night('2026-06-02'),
            night('2026-06-04'),
          ],
        }),
        [],
        ctx,
      ),
    ).toThrow(/does not match expected/);
  });

  it('rejects negative minor-unit amounts', () => {
    expect(() =>
      evaluateAuthoredOffer(
        offer({
          nights: [
            night('2026-06-01', -100n),
            night('2026-06-02'),
            night('2026-06-03'),
          ],
        }),
        [],
        ctx,
      ),
    ).toThrow(/non-negative/);
  });

  it('rejects malformed checkIn date', () => {
    expect(() =>
      evaluateAuthoredOffer(
        offer({
          checkIn: '2026/06/01',
          nights: [night('2026-06-01'), night('2026-06-02'), night('2026-06-03')],
        }),
        [],
        ctx,
      ),
    ).toThrow(/ISO YYYY-MM-DD/);
  });
});
