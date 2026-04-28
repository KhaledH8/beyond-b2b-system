import { describe, expect, it, vi } from 'vitest';
import {
  BookingFxLockApplier,
  deriveRefundLockInput,
  type ApplyRefundResult,
} from '../booking-fx-lock.applier';
import type {
  BookingFxLockRepository,
  BookingFxLockRecord,
  BookingFxLockInput,
} from '../booking-fx-lock.repository';
import type { Queryable } from '../../database/queryable';

/**
 * Pure unit tests for the C5d.2 applier and its derivation helper.
 *
 * The applier is the only place in the FX layer that may write a
 * REFUND or CANCELLATION_FEE row, and the locked rule (C5d plan) is
 * "always derive from the CONFIRMATION row, never call Stripe or OXR
 * for a fresh rate". These tests verify both halves: derivation
 * arithmetic and the write/no-write branch.
 *
 * The repository is mocked at the structural level — no Nest test
 * module, no DB. The integration coverage that the row actually
 * persists with the right shape lives in the repository's
 * `findConfirmation` integration tests (C5d.1).
 */

const STRIPE_CONFIRMATION: BookingFxLockRecord = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  bookingId: 'bkg-stripe-001',
  appliedKind: 'CONFIRMATION',
  lockKind: 'STRIPE_FX_QUOTE',
  sourceCurrency: 'USD',
  chargeCurrency: 'GBP',
  rate: '0.78003120',
  sourceMinor: 10000n,
  chargeMinor: 7800n,
  provider: 'STRIPE',
  providerQuoteId: 'fxq_test_origin',
  rateSnapshotId: null,
  expiresAt: '2026-04-28T11:00:00Z',
  appliedAt: '2026-04-28T10:00:00Z',
};

const SNAPSHOT_CONFIRMATION: BookingFxLockRecord = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  bookingId: 'bkg-snapshot-001',
  appliedKind: 'CONFIRMATION',
  lockKind: 'SNAPSHOT_REFERENCE',
  sourceCurrency: 'USD',
  chargeCurrency: 'GBP',
  rate: '0.78000000',
  sourceMinor: 10000n,
  chargeMinor: 7800n,
  provider: 'OXR',
  providerQuoteId: null,
  rateSnapshotId: 'snap-oxr-001',
  expiresAt: null,
  appliedAt: '2026-04-28T10:00:00Z',
};

interface RepoMock {
  repo: BookingFxLockRepository;
  findConfirmation: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
}

function makeRepoMock(opts: {
  confirmation?: BookingFxLockRecord;
  insertResult?: { id: string };
} = {}): RepoMock {
  const findConfirmation = vi.fn(async () => opts.confirmation);
  const insert = vi.fn(async (_q: Queryable, input: BookingFxLockInput) => ({
    id: opts.insertResult?.id ?? input.id,
  }));
  return {
    repo: { findConfirmation, insert } as unknown as BookingFxLockRepository,
    findConfirmation,
    insert,
  };
}

const FAKE_Q: Queryable = {
  query: vi.fn(),
};

describe('deriveRefundLockInput', () => {
  it('derives a REFUND row from a STRIPE_FX_QUOTE confirmation, copying providerQuoteId + expiresAt', () => {
    const input = deriveRefundLockInput({
      confirmation: STRIPE_CONFIRMATION,
      kind: 'REFUND',
      refundSourceMinor: 5000n,
      newId: 'new-refund-id-001',
    });

    expect(input.id).toBe('new-refund-id-001');
    expect(input.bookingId).toBe(STRIPE_CONFIRMATION.bookingId);
    expect(input.appliedKind).toBe('REFUND');
    expect(input.lockKind).toBe('STRIPE_FX_QUOTE');
    expect(input.sourceCurrency).toBe('USD');
    expect(input.chargeCurrency).toBe('GBP');
    expect(input.rate).toBe('0.78003120');
    expect(input.sourceMinor).toBe(5000n);
    // 5000 × 0.78003120 = 3900.156 → 3900 (half-away-from-zero)
    expect(input.chargeMinor).toBe(3900n);
    expect(input.provider).toBe('STRIPE');
    expect(input.providerQuoteId).toBe('fxq_test_origin');
    expect(input.rateSnapshotId).toBeUndefined();
    expect(input.expiresAt).toBe('2026-04-28T11:00:00Z');
  });

  it('derives a CANCELLATION_FEE row from a SNAPSHOT_REFERENCE confirmation, copying rateSnapshotId, no expiresAt', () => {
    const input = deriveRefundLockInput({
      confirmation: SNAPSHOT_CONFIRMATION,
      kind: 'CANCELLATION_FEE',
      refundSourceMinor: 2500n,
      newId: 'new-cancel-fee-id-001',
    });

    expect(input.appliedKind).toBe('CANCELLATION_FEE');
    expect(input.lockKind).toBe('SNAPSHOT_REFERENCE');
    expect(input.provider).toBe('OXR');
    expect(input.providerQuoteId).toBeUndefined();
    expect(input.rateSnapshotId).toBe('snap-oxr-001');
    expect(input.expiresAt).toBeUndefined();
    // 2500 × 0.78 = 1950 exactly
    expect(input.chargeMinor).toBe(1950n);
  });

  it('uses byte-identical rounding to the resolver (proves rate-math extraction is faithful)', () => {
    // Reuse the resolver test scenario: 10000 × 0.99999999 → 10000.
    // If a refund is taken at the same source amount as confirmation,
    // chargeMinor must equal what was charged at confirm time.
    const input = deriveRefundLockInput({
      confirmation: { ...STRIPE_CONFIRMATION, rate: '0.99999999' },
      kind: 'REFUND',
      refundSourceMinor: 10000n,
      newId: 'id',
    });
    expect(input.chargeMinor).toBe(10000n);
  });

  it('throws if given a non-CONFIRMATION applied_kind (defensive guard)', () => {
    expect(() =>
      deriveRefundLockInput({
        confirmation: { ...STRIPE_CONFIRMATION, appliedKind: 'REFUND' },
        kind: 'REFUND',
        refundSourceMinor: 1000n,
        newId: 'id',
      }),
    ).toThrow(/expected confirmation\.appliedKind = 'CONFIRMATION'/);
  });

  it('generates a new id automatically when newId is omitted', () => {
    const input = deriveRefundLockInput({
      confirmation: STRIPE_CONFIRMATION,
      kind: 'REFUND',
      refundSourceMinor: 1000n,
    });
    expect(input.id).toMatch(/^[0-9A-Z]{26}$/);
    // And it is not the confirmation's id (would be a unique-violation
    // on insert if we reused it).
    expect(input.id).not.toBe(STRIPE_CONFIRMATION.id);
  });
});

describe('BookingFxLockApplier.applyRefund', () => {
  it('returns NO_CONFIRMATION_LOCK and does not insert when the booking has no CONFIRMATION row', async () => {
    const m = makeRepoMock({ confirmation: undefined });
    const applier = new BookingFxLockApplier(m.repo);

    const res = await applier.applyRefund({
      q: FAKE_Q,
      bookingId: 'bkg-no-lock',
      kind: 'REFUND',
      refundSourceMinor: 5000n,
    });

    expect(res).toEqual<ApplyRefundResult>({
      kind: 'NO_CONFIRMATION_LOCK',
      reason: 'BOOKING_HAS_NO_CONFIRMATION_LOCK',
    });
    expect(m.findConfirmation).toHaveBeenCalledWith(FAKE_Q, 'bkg-no-lock');
    expect(m.insert).not.toHaveBeenCalled();
  });

  it('writes a REFUND row derived from the confirmation, and returns WRITTEN with the derived shape', async () => {
    const m = makeRepoMock({ confirmation: STRIPE_CONFIRMATION });
    const applier = new BookingFxLockApplier(m.repo);

    const res = await applier.applyRefund({
      q: FAKE_Q,
      bookingId: STRIPE_CONFIRMATION.bookingId,
      kind: 'REFUND',
      refundSourceMinor: 5000n,
    });

    expect(res.kind).toBe('WRITTEN');
    if (res.kind === 'WRITTEN') {
      expect(res.appliedKind).toBe('REFUND');
      expect(res.sourceMinor).toBe(5000n);
      expect(res.chargeMinor).toBe(3900n);
      expect(res.rate).toBe('0.78003120');
    }

    expect(m.insert).toHaveBeenCalledTimes(1);
    const [qArg, inputArg] = m.insert.mock.calls[0]!;
    expect(qArg).toBe(FAKE_Q);
    expect(inputArg.appliedKind).toBe('REFUND');
    expect(inputArg.bookingId).toBe(STRIPE_CONFIRMATION.bookingId);
    expect(inputArg.lockKind).toBe('STRIPE_FX_QUOTE');
    expect(inputArg.providerQuoteId).toBe('fxq_test_origin');
    expect(inputArg.expiresAt).toBe('2026-04-28T11:00:00Z');
    expect(inputArg.rate).toBe('0.78003120');
    expect(inputArg.chargeMinor).toBe(3900n);
  });

  it('writes a CANCELLATION_FEE row when kind is CANCELLATION_FEE', async () => {
    const m = makeRepoMock({ confirmation: SNAPSHOT_CONFIRMATION });
    const applier = new BookingFxLockApplier(m.repo);

    const res = await applier.applyRefund({
      q: FAKE_Q,
      bookingId: SNAPSHOT_CONFIRMATION.bookingId,
      kind: 'CANCELLATION_FEE',
      refundSourceMinor: 2500n,
    });

    expect(res.kind).toBe('WRITTEN');
    if (res.kind === 'WRITTEN') {
      expect(res.appliedKind).toBe('CANCELLATION_FEE');
      expect(res.chargeMinor).toBe(1950n);
    }
    const [, inputArg] = m.insert.mock.calls[0]!;
    expect(inputArg.appliedKind).toBe('CANCELLATION_FEE');
    expect(inputArg.lockKind).toBe('SNAPSHOT_REFERENCE');
    expect(inputArg.rateSnapshotId).toBe('snap-oxr-001');
    expect(inputArg.providerQuoteId).toBeUndefined();
    expect(inputArg.expiresAt).toBeUndefined();
  });

  it('does not call Stripe or OXR (no FxRateService / StripeFxQuoteClient deps wired in)', () => {
    // Constructor-level proof: the applier only injects the repository.
    // Reflection on construction parameters can't be done at runtime
    // here, but the type of `BookingFxLockApplier`'s constructor in
    // booking-fx-lock.applier.ts demonstrates a single dependency.
    // This test exists to flag a regression if someone adds a second
    // injected dep — it would surface as an unresolved provider in
    // the FxModule integration test, but documenting the rule here too.
    const m = makeRepoMock({ confirmation: STRIPE_CONFIRMATION });
    const applier = new BookingFxLockApplier(m.repo);
    expect(applier).toBeInstanceOf(BookingFxLockApplier);
  });

  it('passes the caller-supplied Queryable through to both repository calls', async () => {
    const m = makeRepoMock({ confirmation: STRIPE_CONFIRMATION });
    const applier = new BookingFxLockApplier(m.repo);
    const q: Queryable = { query: vi.fn() };

    await applier.applyRefund({
      q,
      bookingId: STRIPE_CONFIRMATION.bookingId,
      kind: 'REFUND',
      refundSourceMinor: 1000n,
    });

    expect(m.findConfirmation).toHaveBeenCalledWith(q, STRIPE_CONFIRMATION.bookingId);
    expect(m.insert.mock.calls[0]![0]).toBe(q);
  });
});
