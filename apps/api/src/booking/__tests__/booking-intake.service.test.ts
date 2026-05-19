import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { BookingIntakeService } from '../booking-intake.service';
import type {
  BookingIntakeRecord,
  BookingRepository,
} from '../booking.repository';
import type { AuditService } from '../../audit/audit.service';

/**
 * Pure unit tests for BookingIntakeService.create. The pg pool/client,
 * the booking repository, and the audit service are all mocked. No DB,
 * no Nest test module.
 */

const TENANT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACCOUNT = '01ARZ3NDEKTSV4RRFFQ69G5FBA';
const HOTEL = '01ARZ3NDEKTSV4RRFFQ69G5FHT';
const SNAPSHOT = '01ARZ3NDEKTSV4RRFFQ69G5FSN';

function validBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    tenantId: TENANT,
    accountId: ACCOUNT,
    canonicalHotelId: HOTEL,
    sourceOfferSnapshotId: SNAPSHOT,
    supplier: 'HOTELBEDS',
    supplierRawRef: 'raw-ref-123',
    checkIn: '2026-06-01',
    checkOut: '2026-06-03',
    occupancy: { adults: 2 },
    guestDetails: { firstName: 'A', lastName: 'B', email: 'a@b.com' },
    sellAmountMinorUnits: 12345,
    sellCurrency: 'USD',
    moneyMovement: {
      collectionMode: 'BB_COLLECTS',
      supplierSettlementMode: 'PREPAID_BALANCE',
      paymentCostModel: 'PLATFORM_CARD_FEE',
    },
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<BookingIntakeRecord> = {},
): BookingIntakeRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5BKG',
    tenantId: TENANT,
    accountId: ACCOUNT,
    reference: 'BB-2026-00042',
    status: 'INITIATED',
    sourceOfferSnapshotId: SNAPSHOT,
    supplierRef: 'HOTELBEDS',
    supplierRawRef: 'raw-ref-123',
    sellAmountMinorUnits: 12345n,
    sellCurrency: 'USD',
    checkIn: '2026-06-01',
    checkOut: '2026-06-03',
    createdAt: '2026-05-15T10:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  service: BookingIntakeService;
  calls: string[];
  clientQuery: ReturnType<typeof vi.fn>;
  findByIdempotencyKey: ReturnType<typeof vi.fn>;
  insertInitiated: ReturnType<typeof vi.fn>;
  emitInTransaction: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const calls: string[] = [];
  const clientQuery = vi.fn(async (sql: string) => {
    calls.push(`SQL:${sql}`);
    return { rows: [] };
  });
  const release = vi.fn();
  const client = {
    query: clientQuery,
    release,
  } as unknown as PoolClient;
  const connect = vi.fn(async () => {
    calls.push('CONNECT');
    return client;
  });
  const pool = { connect } as unknown as Pool;

  const findByIdempotencyKey = vi.fn(async () => undefined);
  const insertInitiated = vi.fn(async () => {
    calls.push('INSERT');
    return makeRecord();
  });
  const repository = {
    findByIdempotencyKey,
    insertInitiated,
  } as unknown as BookingRepository;

  const emitInTransaction = vi.fn(async () => {
    calls.push('AUDIT');
  });
  const auditService = {
    emitInTransaction,
  } as unknown as AuditService;

  const service = new BookingIntakeService(
    pool,
    repository,
    auditService,
  );
  return {
    service,
    calls,
    clientQuery,
    findByIdempotencyKey,
    insertInitiated,
    emitInTransaction,
    connect,
    release,
  };
}

function uniqueViolation(constraint: string): Error {
  const e = new Error('duplicate key value violates unique constraint');
  Object.assign(e, { code: '23505', constraint });
  return e;
}

describe('BookingIntakeService.create — happy path', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('creates an INITIATED booking and returns the view with replayed=false', async () => {
    const result = await h.service.create(validBody());
    expect(result.replayed).toBe(false);
    expect(result.booking).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5BKG',
      tenantId: TENANT,
      accountId: ACCOUNT,
      reference: 'BB-2026-00042',
      status: 'INITIATED',
      sourceOfferSnapshotId: SNAPSHOT,
      supplier: 'HOTELBEDS',
      supplierRawRef: 'raw-ref-123',
      sellAmountMinorUnits: 12345,
      sellCurrency: 'USD',
      checkIn: '2026-06-01',
      checkOut: '2026-06-03',
      createdAt: '2026-05-15T10:00:00.000Z',
    });
  });

  it('emits BOOKING_CREATED in the transaction, after INSERT and before COMMIT', async () => {
    await h.service.create(validBody());
    const order = h.calls.filter(
      (c) => c === 'INSERT' || c === 'AUDIT' || c === 'SQL:COMMIT',
    );
    expect(order).toEqual(['INSERT', 'AUDIT', 'SQL:COMMIT']);
    const [client, event] = h.emitInTransaction.mock.calls[0]!;
    expect(client).toBeDefined();
    expect(event).toMatchObject({
      category: 'APP',
      kind: 'BOOKING_CREATED',
      tenantId: TENANT,
      targetId: '01ARZ3NDEKTSV4RRFFQ69G5BKG',
      payload: {
        bookingId: '01ARZ3NDEKTSV4RRFFQ69G5BKG',
        tenantId: TENANT,
        accountId: ACCOUNT,
        bookingReference: 'BB-2026-00042',
        sourceOfferSnapshotId: SNAPSHOT,
        supplier: 'HOTELBEDS',
        supplierRawRef: 'raw-ref-123',
        sellAmountMinorUnits: '12345',
        sellCurrency: 'USD',
        status: 'INITIATED',
      },
    });
  });

  it('opens a transaction and releases the client', async () => {
    await h.service.create(validBody());
    expect(h.calls).toContain('CONNECT');
    expect(h.clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(h.clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe('BookingIntakeService.create — validation', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('rejects missing sellAmountMinorUnits as missing pricing', async () => {
    await expect(
      h.service.create(validBody({ sellAmountMinorUnits: undefined })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('rejects missing sellCurrency as missing pricing', async () => {
    await expect(
      h.service.create(validBody({ sellCurrency: undefined })),
    ).rejects.toThrow(/pricing not pinned/);
  });

  it('rejects a zero/negative sell amount', async () => {
    await expect(
      h.service.create(validBody({ sellAmountMinorUnits: 0 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a malformed tenantId ULID', async () => {
    await expect(
      h.service.create(validBody({ tenantId: 'not-a-ulid' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an off-enum collectionMode', async () => {
    await expect(
      h.service.create(
        validBody({
          moneyMovement: {
            collectionMode: 'NONSENSE',
            supplierSettlementMode: 'PREPAID_BALANCE',
            paymentCostModel: 'PLATFORM_CARD_FEE',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects checkOut <= checkIn', async () => {
    await expect(
      h.service.create(
        validBody({ checkIn: '2026-06-03', checkOut: '2026-06-01' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts hotelId as an alias for canonicalHotelId', async () => {
    const body = validBody({ canonicalHotelId: undefined, hotelId: HOTEL });
    const result = await h.service.create(body);
    expect(result.replayed).toBe(false);
  });
});

describe('BookingIntakeService.create — bookability gate (ADR-020)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('refuses a PROVISIONAL money-movement rate with 422', async () => {
    await expect(
      h.service.create(
        validBody({ moneyMovementProvenance: 'PROVISIONAL' }),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('refuses an explicitly not-bookable rate with 422', async () => {
    await expect(
      h.service.create(validBody({ isBookable: false })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('accepts CONFIG_RESOLVED / PAYLOAD_DERIVED provenance', async () => {
    const r = await h.service.create(
      validBody({ moneyMovementProvenance: 'CONFIG_RESOLVED' }),
    );
    expect(r.replayed).toBe(false);
  });
});

describe('BookingIntakeService.create — audit durability', () => {
  it('rolls back and does not COMMIT when the audit emit fails', async () => {
    const h = makeHarness();
    h.emitInTransaction.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(h.service.create(validBody())).rejects.toThrow(
      /audit insert failed/,
    );
    expect(h.clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(h.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(h.clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe('BookingIntakeService.create — idempotency', () => {
  it('fast-path replay returns the existing booking without a tx or audit', async () => {
    const h = makeHarness();
    h.findByIdempotencyKey.mockResolvedValueOnce(makeRecord());

    const result = await h.service.create(validBody());
    expect(result.replayed).toBe(true);
    expect(result.booking.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5BKG');
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.insertInitiated).not.toHaveBeenCalled();
    expect(h.emitInTransaction).not.toHaveBeenCalled();
  });

  it('idempotency-key race rolls back, re-reads the winner, emits no second audit', async () => {
    const h = makeHarness();
    h.findByIdempotencyKey
      .mockResolvedValueOnce(undefined) // pre-tx fast path: none yet
      .mockResolvedValueOnce(makeRecord()); // post-rollback: winner
    h.insertInitiated.mockRejectedValueOnce(
      uniqueViolation('booking_booking_idem_uq'),
    );

    const result = await h.service.create(validBody());
    expect(result.replayed).toBe(true);
    expect(h.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(h.emitInTransaction).not.toHaveBeenCalled();
  });

  it('retries with a fresh reference on a reference-uniqueness collision', async () => {
    const h = makeHarness();
    h.insertInitiated
      .mockRejectedValueOnce(uniqueViolation('booking_booking_ref_uq'))
      .mockImplementationOnce(async () => makeRecord());

    const result = await h.service.create(validBody());
    expect(result.replayed).toBe(false);
    expect(h.insertInitiated).toHaveBeenCalledTimes(2);
    expect(h.emitInTransaction).toHaveBeenCalledTimes(1);
  });

  it('gives up after the reference-retry limit', async () => {
    const h = makeHarness();
    h.insertInitiated.mockRejectedValue(
      uniqueViolation('booking_booking_ref_uq'),
    );

    await expect(h.service.create(validBody())).rejects.toThrow(
      /unique booking reference/,
    );
    expect(h.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
