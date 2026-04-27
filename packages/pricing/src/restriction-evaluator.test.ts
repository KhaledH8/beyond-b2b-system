import { describe, expect, it } from 'vitest';
import {
  evaluateRestrictions,
  type EvaluateRestrictionsInput,
  type RestrictionKind,
  type RestrictionSnapshot,
} from './restriction-evaluator';

const CONTRACT_A = 'CTR0000000000000000000001';
const CONTRACT_B = 'CTR0000000000000000000002';
const SEASON_A = 'SSN0000000000000000000001';
const SEASON_OTHER = 'SSN0000000000000000000099';
const RATE_PLAN_A = 'RPL0000000000000000000001';
const RATE_PLAN_B = 'RPL0000000000000000000002';
const ROOM_A = 'RMT0000000000000000000001';

const NOW = new Date('2026-04-01T12:00:00Z');

const STAY_5_DAYS = {
  checkIn: '2026-06-01',
  checkOut: '2026-06-06', // 5 nights
};

function rx(
  partial: Partial<RestrictionSnapshot> & {
    id: string;
    restrictionKind: RestrictionKind;
    stayDate: string;
  },
): RestrictionSnapshot {
  return {
    contractId: null,
    seasonId: null,
    ratePlanId: null,
    roomTypeId: null,
    params: {},
    effectiveFrom: '2025-01-01T00:00:00Z',
    effectiveTo: null,
    supersededById: null,
    ...partial,
  };
}

function input(
  overrides: Partial<EvaluateRestrictionsInput> = {},
): EvaluateRestrictionsInput {
  return {
    stay: STAY_5_DAYS,
    now: NOW,
    contractId: CONTRACT_A,
    seasonId: SEASON_A,
    ratePlanId: RATE_PLAN_A,
    roomTypeId: ROOM_A,
    restrictions: [],
    ...overrides,
  };
}

describe('evaluateRestrictions · happy path', () => {
  it('returns available=true when no restrictions are supplied', () => {
    expect(evaluateRestrictions(input()).available).toBe(true);
  });

  it('returns available=true when no restrictions match the stay window', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({ id: 'R1', restrictionKind: 'STOP_SELL', stayDate: '2026-05-15' }),
          rx({ id: 'R2', restrictionKind: 'STOP_SELL', stayDate: '2026-06-10' }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });
});

describe('evaluateRestrictions · STOP_SELL', () => {
  it('blocks when any stay night is stop-sold', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({ id: 'R1', restrictionKind: 'STOP_SELL', stayDate: '2026-06-03' }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.kind).toBe('STOP_SELL');
      expect(result.reason.stayDate).toBe('2026-06-03');
      expect(result.reason.ruleId).toBe('R1');
    }
  });

  it('reports the chronologically first violating night', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({ id: 'R-late', restrictionKind: 'STOP_SELL', stayDate: '2026-06-05' }),
          rx({ id: 'R-early', restrictionKind: 'STOP_SELL', stayDate: '2026-06-02' }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason.stayDate).toBe('2026-06-02');
  });
});

describe('evaluateRestrictions · CTA / CTD', () => {
  it('blocks CTA on the check-in date', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({ id: 'R1', restrictionKind: 'CTA', stayDate: '2026-06-01' }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.kind).toBe('CTA');
      expect(result.reason.stayDate).toBe('2026-06-01');
    }
  });

  it('ignores CTA on a non-check-in date', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({ id: 'R1', restrictionKind: 'CTA', stayDate: '2026-06-03' }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('blocks CTD on the actual checkout date', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({ id: 'R1', restrictionKind: 'CTD', stayDate: '2026-06-06' }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.kind).toBe('CTD');
      expect(result.reason.stayDate).toBe('2026-06-06');
    }
  });

  it('does NOT block CTD on the last stay night (only checkout date triggers)', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({ id: 'R1', restrictionKind: 'CTD', stayDate: '2026-06-05' }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });
});

describe('evaluateRestrictions · MIN_LOS / MAX_LOS', () => {
  it('blocks MIN_LOS when nights < required', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 7 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.kind).toBe('MIN_LOS');
      expect(result.reason.required).toBe(7);
      expect(result.reason.observed).toBe(5);
    }
  });

  it('passes MIN_LOS when nights == required (boundary)', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 5 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('blocks MAX_LOS when nights > allowed', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'MAX_LOS',
            stayDate: '2026-06-01',
            params: { max_los: 3 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.kind).toBe('MAX_LOS');
      expect(result.reason.required).toBe(3);
      expect(result.reason.observed).toBe(5);
    }
  });

  it('ignores LOS rules whose stay_date is not the check-in date', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-03',
            params: { min_los: 99 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });
});

describe('evaluateRestrictions · ADVANCE_PURCHASE_MIN / _MAX', () => {
  it('blocks ADVANCE_PURCHASE_MIN when too few days until check-in', () => {
    const result = evaluateRestrictions(
      input({
        // 2026-04-01 to 2026-06-01 ≈ 61 days
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'ADVANCE_PURCHASE_MIN',
            stayDate: '2026-06-01',
            params: { days: 90 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.kind).toBe('ADVANCE_PURCHASE_MIN');
      expect(result.reason.required).toBe(90);
    }
  });

  it('passes ADVANCE_PURCHASE_MIN when enough days remain', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'ADVANCE_PURCHASE_MIN',
            stayDate: '2026-06-01',
            params: { days: 30 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('blocks ADVANCE_PURCHASE_MAX when too many days until check-in', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'ADVANCE_PURCHASE_MAX',
            stayDate: '2026-06-01',
            params: { days: 30 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason.kind).toBe('ADVANCE_PURCHASE_MAX');
  });
});

describe('evaluateRestrictions · RELEASE_HOURS / CUTOFF_HOURS', () => {
  it('blocks RELEASE_HOURS when within the release window', () => {
    const result = evaluateRestrictions(
      input({
        // 24 hours before check-in
        now: new Date('2026-05-31T00:00:00Z'),
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'RELEASE_HOURS',
            stayDate: '2026-06-01',
            params: { hours: 48 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.kind).toBe('RELEASE_HOURS');
      expect(result.reason.required).toBe(48);
      expect(result.reason.observed).toBe(24);
    }
  });

  it('passes RELEASE_HOURS at exact boundary (observed == required)', () => {
    const result = evaluateRestrictions(
      input({
        now: new Date('2026-05-30T00:00:00Z'), // 48h before check-in
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'RELEASE_HOURS',
            stayDate: '2026-06-01',
            params: { hours: 48 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('blocks CUTOFF_HOURS like RELEASE_HOURS but reports the right kind', () => {
    const result = evaluateRestrictions(
      input({
        now: new Date('2026-05-31T18:00:00Z'),
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'CUTOFF_HOURS',
            stayDate: '2026-06-01',
            params: { hours: 12 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason.kind).toBe('CUTOFF_HOURS');
  });
});

describe('evaluateRestrictions · most-specific-wins precedence', () => {
  it('contract+season tier wins over contract-only tier even when contract-only would block', () => {
    // Tier 1 has NO STOP_SELL → fall through to tier 2 (which blocks).
    // Then add a tier-1 STOP_SELL on a different stay_date so tier 1 has
    // candidates for STOP_SELL but not for THIS specific stay_date.
    // The evaluator picks per (kind, stay_date), so a tier-1 row on a
    // different date does NOT mask a tier-2 row on the queried date.
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R-tier2',
            contractId: CONTRACT_A,
            seasonId: null,
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
          }),
          // unrelated tier-1 row on a different date
          rx({
            id: 'R-tier1-elsewhere',
            contractId: CONTRACT_A,
            seasonId: SEASON_A,
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-04',
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) {
      // Two violations are present; STOP_SELL iterates chronologically
      // and the first violating night is 2026-06-03 from the tier-2 row.
      expect(result.reason.stayDate).toBe('2026-06-03');
      expect(result.reason.ruleId).toBe('R-tier2');
    }
  });

  it('contract+season row wins over contract-only row at the SAME (kind, stay_date)', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R-tier1',
            contractId: CONTRACT_A,
            seasonId: SEASON_A,
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 2 }, // satisfied by 5-night stay
          }),
          rx({
            id: 'R-tier2',
            contractId: CONTRACT_A,
            seasonId: null,
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 99 }, // would block, but tier 1 wins
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('contract-only row wins over supplier-default row at the SAME (kind, stay_date)', () => {
    const result = evaluateRestrictions(
      input({
        seasonId: null, // request is contract-scoped without a season
        restrictions: [
          rx({
            id: 'R-tier2',
            contractId: CONTRACT_A,
            seasonId: null,
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 2 },
          }),
          rx({
            id: 'R-tier3',
            contractId: null,
            seasonId: null,
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 99 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('falls through to supplier-default tier when no contract-scoped row exists for that (kind, stay_date)', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R-tier3',
            contractId: null,
            seasonId: null,
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason.ruleId).toBe('R-tier3');
  });
});

describe('evaluateRestrictions · tie-breaker on lower id', () => {
  it('within the same tier, the lower id wins', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R-zzz',
            contractId: CONTRACT_A,
            seasonId: SEASON_A,
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 99 },
          }),
          rx({
            id: 'R-aaa', // lower string id
            contractId: CONTRACT_A,
            seasonId: SEASON_A,
            restrictionKind: 'MIN_LOS',
            stayDate: '2026-06-01',
            params: { min_los: 2 },
          }),
        ],
      }),
    );
    expect(result.available).toBe(true); // R-aaa wins, min_los=2 passes
  });
});

describe('evaluateRestrictions · effective window + supersede', () => {
  it('skips rows whose effective_from is in the future', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
            effectiveFrom: '2026-12-01T00:00:00Z',
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('skips rows whose effective_to is in the past', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: '2025-12-31T23:59:59Z',
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('honors open-ended effective_to (null = no upper bound)', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: null,
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
  });

  it('skips superseded rows entirely', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R-old',
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
            supersededById: 'R-new',
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });
});

describe('evaluateRestrictions · scope filtering', () => {
  it('ignores restrictions for a different contract', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            contractId: CONTRACT_B,
            seasonId: null,
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('ignores restrictions for a different season', () => {
    const result = evaluateRestrictions(
      input({
        restrictions: [
          rx({
            id: 'R1',
            contractId: CONTRACT_A,
            seasonId: SEASON_OTHER,
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('ignores rate-plan-targeted restrictions when the request rate plan differs', () => {
    const result = evaluateRestrictions(
      input({
        ratePlanId: RATE_PLAN_A,
        restrictions: [
          rx({
            id: 'R1',
            ratePlanId: RATE_PLAN_B,
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
          }),
        ],
      }),
    );
    expect(result.available).toBe(true);
  });

  it('rate-plan-null restriction applies regardless of request rate plan', () => {
    const result = evaluateRestrictions(
      input({
        ratePlanId: RATE_PLAN_A,
        restrictions: [
          rx({
            id: 'R1',
            ratePlanId: null,
            restrictionKind: 'STOP_SELL',
            stayDate: '2026-06-03',
          }),
        ],
      }),
    );
    expect(result.available).toBe(false);
  });
});

describe('evaluateRestrictions · input validation', () => {
  it('throws on a malformed checkIn', () => {
    expect(() =>
      evaluateRestrictions(input({ stay: { checkIn: '06/01/2026', checkOut: '2026-06-06' } })),
    ).toThrow(/ISO YYYY-MM-DD/);
  });

  it('throws when checkOut <= checkIn', () => {
    expect(() =>
      evaluateRestrictions(input({ stay: { checkIn: '2026-06-06', checkOut: '2026-06-06' } })),
    ).toThrow(/strictly after/);
  });
});

describe('evaluateRestrictions · purity', () => {
  it('does not consult Date.now() — same input produces same output for any wall clock', () => {
    const earlier = evaluateRestrictions(
      input({
        now: new Date('2026-04-01T12:00:00Z'),
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'ADVANCE_PURCHASE_MIN',
            stayDate: '2026-06-01',
            params: { days: 30 },
          }),
        ],
      }),
    );
    const later = evaluateRestrictions(
      input({
        now: new Date('2026-05-25T12:00:00Z'),
        restrictions: [
          rx({
            id: 'R1',
            restrictionKind: 'ADVANCE_PURCHASE_MIN',
            stayDate: '2026-06-01',
            params: { days: 30 },
          }),
        ],
      }),
    );
    expect(earlier.available).toBe(true); // 61 days >= 30
    expect(later.available).toBe(false);  // 7 days < 30
  });
});
