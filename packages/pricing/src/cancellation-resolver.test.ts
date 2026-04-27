import { describe, expect, it } from 'vitest';
import {
  resolveCancellationPolicy,
  type CancellationPolicySnapshot,
  type ResolveCancellationPolicyInput,
} from './cancellation-resolver';

const CONTRACT_A = 'CTR0000000000000000000001';
const CONTRACT_B = 'CTR0000000000000000000002';
const RATE_PLAN_A = 'RPL0000000000000000000001';
const RATE_PLAN_B = 'RPL0000000000000000000002';

const NOW = new Date('2026-04-01T12:00:00Z');

function policy(
  partial: Partial<CancellationPolicySnapshot> & {
    id: string;
    policyVersion: number;
  },
): CancellationPolicySnapshot {
  return {
    contractId: null,
    ratePlanId: null,
    windowsJsonb: [],
    refundable: true,
    effectiveFrom: '2025-01-01T00:00:00Z',
    effectiveTo: null,
    supersededById: null,
    ...partial,
  };
}

function input(
  overrides: Partial<ResolveCancellationPolicyInput> = {},
): ResolveCancellationPolicyInput {
  return {
    now: NOW,
    contractId: CONTRACT_A,
    ratePlanId: RATE_PLAN_A,
    policies: [],
    ...overrides,
  };
}

describe('resolveCancellationPolicy · happy path', () => {
  it('returns resolved=false when no policies are supplied', () => {
    expect(resolveCancellationPolicy(input()).resolved).toBe(false);
  });

  it('resolves a single matching policy', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P1');
  });
});

describe('resolveCancellationPolicy · highest version within tier', () => {
  it('picks the higher policy_version when both are in the same tier', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P-v1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
          }),
          policy({
            id: 'P-v2',
            policyVersion: 2,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P-v2');
  });

  it('breaks version ties with the lower id', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P-zzz',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
          }),
          policy({
            id: 'P-aaa',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P-aaa');
  });
});

describe('resolveCancellationPolicy · tier precedence (most-specific-wins)', () => {
  it('tier 1 (contract+ratePlan) wins over tier 2 (contract-only) at the same scope', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          // Higher version on tier 2 — should still LOSE to tier 1.
          policy({
            id: 'P-tier2',
            policyVersion: 99,
            contractId: CONTRACT_A,
            ratePlanId: null,
          }),
          policy({
            id: 'P-tier1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P-tier1');
  });

  it('tier 2 wins over tier 3 (supplier-default with rate plan)', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P-tier3',
            policyVersion: 99,
            contractId: null,
            ratePlanId: RATE_PLAN_A,
          }),
          policy({
            id: 'P-tier2',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: null,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P-tier2');
  });

  it('tier 3 wins over tier 4 (most general)', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P-tier4',
            policyVersion: 99,
            contractId: null,
            ratePlanId: null,
          }),
          policy({
            id: 'P-tier3',
            policyVersion: 1,
            contractId: null,
            ratePlanId: RATE_PLAN_A,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P-tier3');
  });

  it('falls through to tier 4 when no more specific tier has candidates', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P-tier4',
            policyVersion: 1,
            contractId: null,
            ratePlanId: null,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P-tier4');
  });
});

describe('resolveCancellationPolicy · effective window', () => {
  it('skips a policy with effective_from in the future', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            effectiveFrom: '2026-12-01T00:00:00Z',
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(false);
  });

  it('skips a policy with effective_to in the past', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: '2025-12-31T23:59:59Z',
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(false);
  });

  it('honors open-ended effective_to (null)', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: null,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
  });

  it('falls back to a lower-version active policy when the higher version has expired', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P-v1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: null,
          }),
          policy({
            id: 'P-v2',
            policyVersion: 2,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: '2025-12-31T23:59:59Z',
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) expect(result.policy.id).toBe('P-v1');
  });
});

describe('resolveCancellationPolicy · supersede', () => {
  it('skips a superseded policy even when its effective window still covers now', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P-old',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            supersededById: 'P-new',
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(false);
  });
});

describe('resolveCancellationPolicy · scope filtering', () => {
  it('filters out a policy targeting a different contract', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_B,
            ratePlanId: RATE_PLAN_A,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(false);
  });

  it('filters out a policy targeting a different rate plan', () => {
    const result = resolveCancellationPolicy(
      input({
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_B,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(false);
  });

  it('rate-plan-null policy applies regardless of request rate plan', () => {
    const result = resolveCancellationPolicy(
      input({
        ratePlanId: RATE_PLAN_A,
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: null,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
  });

  it('contract-null policy applies regardless of request contract', () => {
    const result = resolveCancellationPolicy(
      input({
        contractId: CONTRACT_A,
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: null,
            ratePlanId: RATE_PLAN_A,
          }),
        ],
      }),
    );
    expect(result.resolved).toBe(true);
  });
});

describe('resolveCancellationPolicy · purity', () => {
  it('does not consult Date.now() — same input produces same output for any wall clock', () => {
    const earlyResult = resolveCancellationPolicy(
      input({
        now: new Date('2026-04-01T00:00:00Z'),
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: '2026-06-30T23:59:59Z',
          }),
        ],
      }),
    );
    const lateResult = resolveCancellationPolicy(
      input({
        now: new Date('2026-12-01T00:00:00Z'),
        policies: [
          policy({
            id: 'P1',
            policyVersion: 1,
            contractId: CONTRACT_A,
            ratePlanId: RATE_PLAN_A,
            effectiveFrom: '2025-01-01T00:00:00Z',
            effectiveTo: '2026-06-30T23:59:59Z',
          }),
        ],
      }),
    );
    expect(earlyResult.resolved).toBe(true);
    expect(lateResult.resolved).toBe(false);
  });
});
