import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { BookingService } from '../booking.service';
import type {
  BookingRecord,
  BookingRepository,
  BookingStatus,
} from '../booking.repository';
import type { BookingFxLockResolver } from '../../fx/booking-fx-lock.resolver';
import type { BookingFxLockRepository } from '../../fx/booking-fx-lock.repository';
import type {
  BookingSnapshotRepository,
  SourceOfferSnapshotRow,
} from '../booking-snapshot.repository';
import type { AuditService } from '../../audit/audit.service';

/**
 * Pure unit tests for BookingService.confirm. The pg pool/client, the
 * booking repository, the FX-lock resolver, and the FX-lock
 * repository are all mocked. No DB, no Nest test module.
 */

const BOOKING_ID = '01ARZ3NDEKTSV4RRFFQ69G5BKG';
const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5TEN';

interface PoolMock {
  pool: Pool;
  connect: ReturnType<typeof vi.fn>;
  client: PoolClient;
  clientQuery: ReturnType<typeof vi.fn>;
  clientRelease: ReturnType<typeof vi.fn>;
}

function makePoolMock(): PoolMock {
  const clientQuery = vi.fn(async () => ({ rows: [] }));
  const clientRelease = vi.fn();
  const client = {
    query: clientQuery,
    release: clientRelease,
  } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;
  return { pool, connect, client, clientQuery, clientRelease };
}

interface RepoMock {
  repository: BookingRepository;
  loadById: ReturnType<typeof vi.fn>;
  markConfirmed: ReturnType<typeof vi.fn>;
}

function makeRepoMock(): RepoMock {
  const loadById = vi.fn();
  const markConfirmed = vi.fn();
  return {
    repository: { loadById, markConfirmed } as unknown as BookingRepository,
    loadById,
    markConfirmed,
  };
}

interface ResolverMock {
  resolver: BookingFxLockResolver;
  resolve: ReturnType<typeof vi.fn>;
}

function makeResolverMock(): ResolverMock {
  const resolve = vi.fn();
  return {
    resolver: { resolve } as unknown as BookingFxLockResolver,
    resolve,
  };
}

interface LockRepoMock {
  lockRepository: BookingFxLockRepository;
  insert: ReturnType<typeof vi.fn>;
}

function makeLockRepoMock(): LockRepoMock {
  const insert = vi.fn(async () => ({ id: 'fx-lock-id' }));
  return {
    lockRepository: { insert } as unknown as BookingFxLockRepository,
    insert,
  };
}

function makeSourceOfferRow(): SourceOfferSnapshotRow {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5SRC',
    tenant_id: TENANT_ID,
    supplier_id: '01ARZ3NDEKTSV4RRFFQ69G5SUP',
    canonical_hotel_id: '01ARZ3NDEKTSV4RRFFQ69G5HOT',
    supplier_hotel_code: 'HB-1',
    supplier_rate_key: 'rate-key-1',
    check_in: '2026-07-01',
    check_out: '2026-07-03',
    occupancy_adults: 2,
    occupancy_children_ages_jsonb: [],
    supplier_room_code: 'DBL',
    canonical_room_type_id: null,
    supplier_rate_code: 'BAR',
    canonical_rate_plan_id: null,
    supplier_meal_code: 'BB',
    canonical_meal_plan_id: null,
    total_amount_minor_units: '10000',
    total_currency: 'USD',
    rate_breakdown_granularity: 'TOTAL_ONLY',
    raw_payload_hash: 'a'.repeat(64),
    raw_payload_storage_ref: 's3://raw/1',
    received_at: '2026-05-19T10:00:00.000Z',
    valid_until: '2026-05-19T11:00:00.000Z',
  };
}

interface SnapshotRepoMock {
  snapshotRepository: BookingSnapshotRepository;
  loadSourceOfferSnapshot: ReturnType<typeof vi.fn>;
  insertBookingSourcedOfferSnapshot: ReturnType<typeof vi.fn>;
  loadSourceComponents: ReturnType<typeof vi.fn>;
  insertBookingPriceComponentSnapshots: ReturnType<typeof vi.fn>;
  insertBookingTaxFeeSnapshots: ReturnType<typeof vi.fn>;
  loadSourceCancellationPolicy: ReturnType<typeof vi.fn>;
  insertBookingCancellationPolicySnapshot: ReturnType<typeof vi.fn>;
  snapshotExistsForBooking: ReturnType<typeof vi.fn>;
}

function makeSnapshotRepoMock(): SnapshotRepoMock {
  const loadSourceOfferSnapshot = vi.fn(async () => makeSourceOfferRow());
  const insertBookingSourcedOfferSnapshot = vi.fn(
    async () => '01ARZ3NDEKTSV4RRFFQ69G5BOS',
  );
  const loadSourceComponents = vi.fn(async () => []);
  const insertBookingPriceComponentSnapshots = vi.fn(async () => 0);
  const insertBookingTaxFeeSnapshots = vi.fn(async () => 0);
  const loadSourceCancellationPolicy = vi.fn(async () => undefined);
  const insertBookingCancellationPolicySnapshot = vi.fn(
    async () => '01ARZ3NDEKTSV4RRFFQ69G5CXL',
  );
  const snapshotExistsForBooking = vi.fn(async () => false);
  return {
    snapshotRepository: {
      loadSourceOfferSnapshot,
      insertBookingSourcedOfferSnapshot,
      loadSourceComponents,
      insertBookingPriceComponentSnapshots,
      insertBookingTaxFeeSnapshots,
      loadSourceCancellationPolicy,
      insertBookingCancellationPolicySnapshot,
      snapshotExistsForBooking,
    } as unknown as BookingSnapshotRepository,
    loadSourceOfferSnapshot,
    insertBookingSourcedOfferSnapshot,
    loadSourceComponents,
    insertBookingPriceComponentSnapshots,
    insertBookingTaxFeeSnapshots,
    loadSourceCancellationPolicy,
    insertBookingCancellationPolicySnapshot,
    snapshotExistsForBooking,
  };
}

interface AuditMock {
  auditService: AuditService;
  emitInTransaction: ReturnType<typeof vi.fn>;
}

function makeAuditMock(): AuditMock {
  const emitInTransaction = vi.fn(async () => undefined);
  return {
    auditService: { emitInTransaction } as unknown as AuditService,
    emitInTransaction,
  };
}

function bookingRecord(
  status: BookingStatus,
  overrides?: Partial<BookingRecord>,
): BookingRecord {
  return {
    id: BOOKING_ID,
    tenantId: TENANT_ID,
    status,
    sellAmountMinorUnits: 10000n,
    sellCurrency: 'USD',
    accountId: '01ARZ3NDEKTSV4RRFFQ69G5ACC',
    reference: 'BB-2026-00099',
    sourceOfferSnapshotId: '01ARZ3NDEKTSV4RRFFQ69G5SRC',
    supplierRef: 'HOTELBEDS',
    supplierRawRef: 'raw-ref-x',
    ...overrides,
  };
}

describe('BookingService.confirm', () => {
  let pool: PoolMock;
  let repo: RepoMock;
  let resolver: ResolverMock;
  let lockRepo: LockRepoMock;
  let snap: SnapshotRepoMock;
  let audit: AuditMock;
  let service: BookingService;

  beforeEach(() => {
    pool = makePoolMock();
    repo = makeRepoMock();
    resolver = makeResolverMock();
    lockRepo = makeLockRepoMock();
    snap = makeSnapshotRepoMock();
    audit = makeAuditMock();
    service = new BookingService(
      pool.pool,
      repo.repository,
      resolver.resolver,
      lockRepo.lockRepository,
      snap.snapshotRepository,
      audit.auditService,
    );
  });

  // ─── Validation guards (pre-load) ────────────────────────────────────────

  it('rejects non-3-letter-uppercase chargeCurrency before any DB call', async () => {
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'usd' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'US' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USDA' }),
    ).rejects.toThrow(BadRequestException);
    expect(repo.loadById).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the booking does not exist', async () => {
    repo.loadById.mockResolvedValue(undefined);
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(NotFoundException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  // ─── Idempotency / terminal-state guards ─────────────────────────────────

  it('returns alreadyConfirmed: true on the idempotency fast-path without opening a tx or calling the resolver', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('CONFIRMED'));
    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'EUR',
    });
    expect(result).toEqual({ bookingId: BOOKING_ID, alreadyConfirmed: true });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(repo.markConfirmed).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(lockRepo.insert).not.toHaveBeenCalled();
  });

  it.each<BookingStatus>(['CANCELLED', 'FAILED', 'REFUNDED'])(
    'throws BadRequestException for terminal status %s',
    async (status) => {
      repo.loadById.mockResolvedValue(bookingRecord(status));
      await expect(
        service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
      ).rejects.toThrow(BadRequestException);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(resolver.resolve).not.toHaveBeenCalled();
    },
  );

  // ─── Pricing-pinned guard (locked policy for C5c.2) ──────────────────────

  it('throws BadRequestException when sell_amount_minor_units is null', async () => {
    repo.loadById.mockResolvedValue(
      bookingRecord('INITIATED', { sellAmountMinorUnits: null }),
    );
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'EUR' }),
    ).rejects.toThrow(/pricing not pinned/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(lockRepo.insert).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when sell_currency is null', async () => {
    repo.loadById.mockResolvedValue(
      bookingRecord('INITIATED', { sellCurrency: null }),
    );
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'EUR' }),
    ).rejects.toThrow(/pricing not pinned/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  // ─── Same-currency short-circuit ─────────────────────────────────────────

  it('skips the resolver and writes no FX row when source equals charge currency', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });

    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'USD', // matches default sellCurrency
    });

    expect(result).toEqual({
      bookingId: BOOKING_ID,
      alreadyConfirmed: false,
      fxOutcome: { kind: 'NO_LOCK_NEEDED' },
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(lockRepo.insert).not.toHaveBeenCalled();
    expect(pool.clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(pool.clientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  // ─── Resolver paths ──────────────────────────────────────────────────────

  it('inserts a STRIPE_FX_QUOTE booking_fx_lock row using the same client as the UPDATE', async () => {
    repo.loadById.mockResolvedValue(
      bookingRecord('INITIATED', { sellCurrency: 'USD', sellAmountMinorUnits: 10000n }),
    );
    repo.markConfirmed.mockResolvedValue({ updated: true });
    resolver.resolve.mockResolvedValue({
      kind: 'STRIPE_FX_QUOTE',
      provider: 'STRIPE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      rate: '0.78003120',
      providerQuoteId: 'fxq_a',
      expiresAt: '2026-04-28T11:00:00Z',
    });

    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'GBP',
    });

    expect(result.alreadyConfirmed).toBe(false);
    expect(result.fxOutcome).toEqual({
      kind: 'STRIPE_FX_QUOTE',
      provider: 'STRIPE',
    });
    expect(resolver.resolve).toHaveBeenCalledWith({
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
    });
    // Lock inserted using the same client (mid-transaction).
    expect(lockRepo.insert).toHaveBeenCalledTimes(1);
    expect(lockRepo.insert).toHaveBeenCalledWith(
      pool.client,
      expect.objectContaining({
        bookingId: BOOKING_ID,
        appliedKind: 'CONFIRMATION',
        lockKind: 'STRIPE_FX_QUOTE',
        provider: 'STRIPE',
        providerQuoteId: 'fxq_a',
        expiresAt: '2026-04-28T11:00:00Z',
        rate: '0.78003120',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
      }),
    );
    expect(pool.clientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  it('inserts a SNAPSHOT_REFERENCE row with provider=OXR when Stripe falls back to OXR', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    resolver.resolve.mockResolvedValue({
      kind: 'SNAPSHOT_REFERENCE',
      provider: 'OXR',
      sourceCurrency: 'USD',
      chargeCurrency: 'EUR',
      sourceMinor: 10000n,
      chargeMinor: 9200n,
      rate: '0.92000000',
      rateSnapshotId: 'snap-oxr-1',
    });

    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'EUR',
    });

    expect(result.fxOutcome).toEqual({
      kind: 'SNAPSHOT_REFERENCE',
      provider: 'OXR',
    });
    expect(lockRepo.insert).toHaveBeenCalledWith(
      pool.client,
      expect.objectContaining({
        lockKind: 'SNAPSHOT_REFERENCE',
        provider: 'OXR',
        rateSnapshotId: 'snap-oxr-1',
      }),
    );
  });

  it('confirms in source currency with no FX row when resolver returns NO_LOCK_AVAILABLE', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    resolver.resolve.mockResolvedValue({
      kind: 'NO_LOCK_AVAILABLE',
      reason: 'STRIPE_FAILED_AND_NO_OXR_SNAPSHOT',
      stripeError: 'connection refused',
    });

    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'JPY',
    });

    expect(result.alreadyConfirmed).toBe(false);
    expect(result.fxOutcome).toEqual({ kind: 'NO_LOCK_AVAILABLE' });
    expect(lockRepo.insert).not.toHaveBeenCalled();
    expect(pool.clientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  // ─── Failure / rollback ──────────────────────────────────────────────────

  it('rolls back when the FX-lock insert throws — booking status update never commits', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    resolver.resolve.mockResolvedValue({
      kind: 'STRIPE_FX_QUOTE',
      provider: 'STRIPE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      rate: '0.78003120',
      providerQuoteId: 'fxq_b',
      expiresAt: '2026-04-28T11:00:00Z',
    });
    const boom = new Error('CHECK violation');
    lockRepo.insert.mockRejectedValue(boom);

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'GBP' }),
    ).rejects.toBe(boom);

    const rollbackCalls = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'ROLLBACK',
    );
    const commitCalls = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'COMMIT',
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(commitCalls.length).toBe(0);
    expect(pool.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('does not open a transaction or write any row when the resolver itself throws', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    const boom = new Error('resolver unavailable');
    resolver.resolve.mockRejectedValue(boom);

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'GBP' }),
    ).rejects.toBe(boom);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(repo.markConfirmed).not.toHaveBeenCalled();
    expect(lockRepo.insert).not.toHaveBeenCalled();
  });

  it('throws ConflictException and ROLLBACKs when markConfirmed returns updated:false (race)', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: false });
    // Resolver still ran pre-tx; verify its effect doesn't sneak through.
    resolver.resolve.mockResolvedValue({
      kind: 'STRIPE_FX_QUOTE',
      provider: 'STRIPE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      rate: '0.78003120',
      providerQuoteId: 'fxq_c',
      expiresAt: '2026-04-28T11:00:00Z',
    });

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'GBP' }),
    ).rejects.toThrow(ConflictException);

    expect(lockRepo.insert).not.toHaveBeenCalled();
    const commitCalls = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'COMMIT',
    );
    expect(commitCalls.length).toBe(0);
    expect(pool.clientRelease).toHaveBeenCalledTimes(1);
  });

  it('releases the client even when ROLLBACK itself fails', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockRejectedValue(new Error('update failed'));
    pool.clientQuery.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('rollback also failed');
      return { rows: [] };
    });

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/update failed/);
    expect(pool.clientRelease).toHaveBeenCalledTimes(1);
  });
});

// ─── C5c.4 — Structured confirm-path observability ───────────────────────────

describe('BookingService.confirm — structured logging', () => {
  let pool: PoolMock;
  let repo: RepoMock;
  let resolver: ResolverMock;
  let lockRepo: LockRepoMock;
  let snap: SnapshotRepoMock;
  let audit: AuditMock;
  let service: BookingService;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pool = makePoolMock();
    repo = makeRepoMock();
    resolver = makeResolverMock();
    lockRepo = makeLockRepoMock();
    snap = makeSnapshotRepoMock();
    audit = makeAuditMock();
    service = new BookingService(
      pool.pool,
      repo.repository,
      resolver.resolver,
      lockRepo.lockRepository,
      snap.snapshotRepository,
      audit.auditService,
    );
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs CONFIRMED with provider + currencies on a successful Stripe-locked confirm', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    resolver.resolve.mockResolvedValue({
      kind: 'STRIPE_FX_QUOTE',
      provider: 'STRIPE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      rate: '0.78003120',
      providerQuoteId: 'fxq_x',
      expiresAt: '2026-04-28T11:00:00Z',
    });

    await service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'GBP' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'booking_confirm',
        outcome: 'CONFIRMED',
        bookingId: BOOKING_ID,
        chargeCurrency: 'GBP',
        sourceCurrency: 'USD',
        alreadyConfirmed: false,
        fxOutcomeKind: 'STRIPE_FX_QUOTE',
        provider: 'STRIPE',
      }),
    );
  });

  it('logs CONFIRMED with NO_LOCK_NEEDED and no provider on same-currency confirm', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });

    await service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const event = logSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['outcome']).toBe('CONFIRMED');
    expect(event['fxOutcomeKind']).toBe('NO_LOCK_NEEDED');
    expect(event['sourceCurrency']).toBe('USD');
    expect(event['chargeCurrency']).toBe('USD');
    expect(event['provider']).toBeUndefined();
  });

  it('logs CONFIRMED with NO_LOCK_AVAILABLE and no provider when resolver degrades', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    resolver.resolve.mockResolvedValue({
      kind: 'NO_LOCK_AVAILABLE',
      reason: 'STRIPE_FAILED_AND_NO_OXR_SNAPSHOT',
    });

    await service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'JPY' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const event = logSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['outcome']).toBe('CONFIRMED');
    expect(event['fxOutcomeKind']).toBe('NO_LOCK_AVAILABLE');
    expect(event['sourceCurrency']).toBe('USD');
    expect(event['chargeCurrency']).toBe('JPY');
    expect(event['provider']).toBeUndefined();
  });

  it('logs ALREADY_CONFIRMED on the idempotency fast-path with no fxOutcomeKind', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('CONFIRMED'));

    await service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'EUR' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const event = logSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['outcome']).toBe('ALREADY_CONFIRMED');
    expect(event['alreadyConfirmed']).toBe(true);
    // No FX recomputation on the fast-path — these fields are absent.
    expect(event['fxOutcomeKind']).toBeUndefined();
    expect(event['provider']).toBeUndefined();
    expect(event['sourceCurrency']).toBeUndefined();
    expect(event['chargeCurrency']).toBe('EUR');
  });

  it('warns with NOT_FOUND when the booking is missing', async () => {
    repo.loadById.mockResolvedValue(undefined);

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(NotFoundException);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'booking_confirm',
        outcome: 'NOT_FOUND',
        bookingId: BOOKING_ID,
        chargeCurrency: 'USD',
        errorReason: expect.stringMatching(/Booking not found/) as unknown,
      }),
    );
  });

  it('warns with INVALID when chargeCurrency fails format validation', async () => {
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'usd' }),
    ).rejects.toThrow(BadRequestException);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const event = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['outcome']).toBe('INVALID');
    // Source currency is unknown at this point — no DB load happened.
    expect(event['sourceCurrency']).toBeUndefined();
    expect(event['chargeCurrency']).toBe('usd');
  });

  it('warns with INVALID and surfaces sourceCurrency=null context for unpriced bookings', async () => {
    repo.loadById.mockResolvedValue(
      bookingRecord('INITIATED', { sellCurrency: null }),
    );

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'EUR' }),
    ).rejects.toThrow(/pricing not pinned/);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const event = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['outcome']).toBe('INVALID');
    expect(event['errorReason']).toMatch(/pricing not pinned/);
    expect(event['chargeCurrency']).toBe('EUR');
    // sourceCurrency is null on the booking; we omit the field rather
    // than emit `null` so log scrapers don't have to special-case it.
    expect(event['sourceCurrency']).toBeUndefined();
  });

  it('warns with CONFLICT when markConfirmed reports a race', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: false });

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(ConflictException);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const event = warnSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['outcome']).toBe('CONFLICT');
    expect(event['sourceCurrency']).toBe('USD');
  });

  it('errors with ERROR when an unexpected throw escapes the transaction', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    const boom = new Error('database is sad');
    repo.markConfirmed.mockRejectedValue(boom);

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toBe(boom);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const event = errorSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['outcome']).toBe('ERROR');
    expect(event['errorReason']).toMatch(/database is sad/);
  });

  it('emits exactly one event per confirm attempt regardless of outcome', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });

    await service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' });

    const totalCalls =
      logSpy.mock.calls.length +
      warnSpy.mock.calls.length +
      errorSpy.mock.calls.length;
    expect(totalCalls).toBe(1);
  });
});

// ─── Booking Truth Slice 2 — ADR-021 snapshot pinning + audit ────────────────

describe('BookingService.confirm — booking-time snapshot pinning', () => {
  let pool: PoolMock;
  let repo: RepoMock;
  let resolver: ResolverMock;
  let lockRepo: LockRepoMock;
  let snap: SnapshotRepoMock;
  let audit: AuditMock;
  let service: BookingService;

  beforeEach(() => {
    pool = makePoolMock();
    repo = makeRepoMock();
    resolver = makeResolverMock();
    lockRepo = makeLockRepoMock();
    snap = makeSnapshotRepoMock();
    audit = makeAuditMock();
    service = new BookingService(
      pool.pool,
      repo.repository,
      resolver.resolver,
      lockRepo.lockRepository,
      snap.snapshotRepository,
      audit.auditService,
    );
  });

  it('pins offer/component/tax snapshots and emits BOOKING_CONFIRMED in the tx, before COMMIT', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });

    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'USD',
    });

    expect(result.alreadyConfirmed).toBe(false);
    expect(snap.loadSourceOfferSnapshot).toHaveBeenCalledWith(
      pool.client,
      TENANT_ID,
      '01ARZ3NDEKTSV4RRFFQ69G5SRC',
    );
    expect(snap.insertBookingSourcedOfferSnapshot).toHaveBeenCalledTimes(1);
    expect(snap.insertBookingPriceComponentSnapshots).toHaveBeenCalledTimes(1);
    expect(snap.insertBookingTaxFeeSnapshots).toHaveBeenCalledTimes(1);
    expect(audit.emitInTransaction).toHaveBeenCalledTimes(1);

    const [client, event] = audit.emitInTransaction.mock.calls[0]!;
    expect(client).toBe(pool.client);
    expect(event).toMatchObject({
      category: 'APP',
      kind: 'BOOKING_CONFIRMED',
      tenantId: TENANT_ID,
      targetId: BOOKING_ID,
      payload: {
        bookingId: BOOKING_ID,
        tenantId: TENANT_ID,
        accountId: '01ARZ3NDEKTSV4RRFFQ69G5ACC',
        bookingReference: 'BB-2026-00099',
        sourceOfferSnapshotId: '01ARZ3NDEKTSV4RRFFQ69G5SRC',
        supplier: 'HOTELBEDS',
        supplierRawRef: 'raw-ref-x',
        sellAmountMinorUnits: '10000',
        sellCurrency: 'USD',
        fxLockId: null,
        status: 'CONFIRMED',
      },
    });
    expect(pool.clientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  it('writes the cancellation-policy snapshot only when the source has one', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    snap.loadSourceCancellationPolicy.mockResolvedValue({
      id: '01ARZ3NDEKTSV4RRFFQ69G5POL',
      windows_jsonb: [],
      refundable: true,
      source_verbatim_text: 'free',
      parsed_with: 'p@1',
    });

    await service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' });
    expect(
      snap.insertBookingCancellationPolicySnapshot,
    ).toHaveBeenCalledTimes(1);
  });

  it('carries the fx-lock id into the BOOKING_CONFIRMED payload', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    resolver.resolve.mockResolvedValue({
      kind: 'SNAPSHOT_REFERENCE',
      provider: 'OXR',
      sourceCurrency: 'USD',
      chargeCurrency: 'EUR',
      sourceMinor: 10000n,
      chargeMinor: 9200n,
      rate: '0.92000000',
      rateSnapshotId: 'snap-oxr-1',
    });

    await service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'EUR' });
    const [, event] = audit.emitInTransaction.mock.calls[0]!;
    const payload = (event as { payload: { fxLockId: string | null } })
      .payload;
    expect(typeof payload.fxLockId).toBe('string');
    expect(payload.fxLockId).not.toBeNull();
  });

  it('rejects confirm pre-tx when source_offer_snapshot_id is null', async () => {
    repo.loadById.mockResolvedValue(
      bookingRecord('INITIATED', { sourceOfferSnapshotId: null }),
    );
    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/source_offer_snapshot_id is not set/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(audit.emitInTransaction).not.toHaveBeenCalled();
  });

  it('rolls back (no COMMIT) when the source offer snapshot is gone', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    snap.loadSourceOfferSnapshot.mockResolvedValue(undefined);

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/source offer.*not found/);
    const commits = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'COMMIT',
    );
    expect(commits.length).toBe(0);
    expect(pool.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(audit.emitInTransaction).not.toHaveBeenCalled();
  });

  it('rolls back when a snapshot insert fails — booking never COMMITs', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    snap.insertBookingSourcedOfferSnapshot.mockRejectedValue(
      new Error('snapshot insert failed'),
    );

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/snapshot insert failed/);
    const commits = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'COMMIT',
    );
    expect(commits.length).toBe(0);
    expect(pool.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(audit.emitInTransaction).not.toHaveBeenCalled();
  });

  it('rolls back when the BOOKING_CONFIRMED audit emit fails', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('INITIATED'));
    repo.markConfirmed.mockResolvedValue({ updated: true });
    audit.emitInTransaction.mockRejectedValue(new Error('audit failed'));

    await expect(
      service.confirm({ bookingId: BOOKING_ID, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/audit failed/);
    const commits = pool.clientQuery.mock.calls.filter(
      (c) => c[0] === 'COMMIT',
    );
    expect(commits.length).toBe(0);
    expect(pool.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('idempotent replay (already CONFIRMED) pins nothing and emits no audit', async () => {
    repo.loadById.mockResolvedValue(bookingRecord('CONFIRMED'));

    const result = await service.confirm({
      bookingId: BOOKING_ID,
      chargeCurrency: 'USD',
    });
    expect(result).toEqual({ bookingId: BOOKING_ID, alreadyConfirmed: true });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(snap.insertBookingSourcedOfferSnapshot).not.toHaveBeenCalled();
    expect(audit.emitInTransaction).not.toHaveBeenCalled();
  });
});
