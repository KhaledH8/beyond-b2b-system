import {
  ConflictException,
  NotFoundException,
  NotImplementedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { BookingSupplierService } from '../booking-supplier.service';
import type { BookingRecord, BookingRepository } from '../booking.repository';
import type { BookingSnapshotRepository } from '../booking-snapshot.repository';
import type { AuditService } from '../../audit/audit.service';
import type { SupplierAdapterRegistry } from '../../adapters/adapter-registry';

const BOOKING_ID = '01ARZ3NDEKTSV4RRFFQ69G5BKG';
const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5TEN';

function record(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: BOOKING_ID,
    tenantId: TENANT_ID,
    status: 'INITIATED',
    sellAmountMinorUnits: 10000n,
    sellCurrency: 'USD',
    accountId: '01ARZ3NDEKTSV4RRFFQ69G5ACC',
    reference: 'BB-2026-00099',
    sourceOfferSnapshotId: '01ARZ3NDEKTSV4RRFFQ69G5SRC',
    supplierRef: 'HOTELBEDS',
    supplierRawRef: 'raw-ref-x',
    supplierId: null,
    supplierConfirmationRef: null,
    supplierBookedAt: null,
    supplierBookingStatus: null,
    supplierBookingMode: null,
    ...overrides,
  };
}

const PINNED = {
  supplier_id: '01ARZ3NDEKTSV4RRFFQ69G5SUP',
  supplier_hotel_code: 'HB-1',
  supplier_rate_key: 'rk-1',
  check_in: '2026-07-01',
  check_out: '2026-07-03',
  occupancy_adults: 2,
};

interface Harness {
  service: BookingSupplierService;
  calls: string[];
  clientQuery: ReturnType<typeof vi.fn>;
  loadById: ReturnType<typeof vi.fn>;
  recordSupplierBooking: ReturnType<typeof vi.fn>;
  loadGuestContact: ReturnType<typeof vi.fn>;
  loadBookingTimeOfferSnapshot: ReturnType<typeof vi.fn>;
  loadSourceOfferSnapshot: ReturnType<typeof vi.fn>;
  book: ReturnType<typeof vi.fn>;
  emitInTransaction: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const calls: string[] = [];
  const clientQuery = vi.fn(async (sql: string) => {
    calls.push(sql);
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query: clientQuery, release } as unknown as PoolClient;
  const connect = vi.fn(async () => {
    calls.push('CONNECT');
    return client;
  });
  const pool = { connect } as unknown as Pool;

  const loadById = vi.fn(async () => record());
  const recordSupplierBooking = vi.fn(async () => {
    calls.push('RECORD');
    return { updated: true };
  });
  const loadGuestContact = vi.fn(async () => ({
    firstName: 'Ada',
    lastName: 'Byron',
    email: 'ada@x.io',
  }));
  const repository = {
    loadById,
    recordSupplierBooking,
    loadGuestContact,
  } as unknown as BookingRepository;

  const loadBookingTimeOfferSnapshot = vi.fn(async () => PINNED);
  const loadSourceOfferSnapshot = vi.fn(async () => undefined);
  const snapshotRepository = {
    loadBookingTimeOfferSnapshot,
    loadSourceOfferSnapshot,
  } as unknown as BookingSnapshotRepository;

  const book = vi.fn(async () => ({
    supplierBookingRef: 'HB-FIX-ABCDEF012345',
    status: 'CONFIRMED' as const,
    confirmedAt: new Date('2026-05-19T10:00:00.000Z'),
  }));
  const registry = {
    get: vi.fn(() => ({ book })),
  } as unknown as SupplierAdapterRegistry;

  const emitInTransaction = vi.fn(async () => {
    calls.push('AUDIT');
  });
  const auditService = {
    emitInTransaction,
  } as unknown as AuditService;

  const service = new BookingSupplierService(
    pool,
    repository,
    snapshotRepository,
    registry,
    auditService,
  );
  return {
    service,
    calls,
    clientQuery,
    loadById,
    recordSupplierBooking,
    loadGuestContact,
    loadBookingTimeOfferSnapshot,
    loadSourceOfferSnapshot,
    book,
    emitInTransaction,
    release,
    connect,
  };
}

describe('BookingSupplierService.supplierBook — happy path', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('books via the adapter, writes fields + audit in one tx, returns view', async () => {
    const result = await h.service.supplierBook(BOOKING_ID);
    expect(result.replayed).toBe(false);
    expect(result.booking).toMatchObject({
      id: BOOKING_ID,
      tenantId: TENANT_ID,
      supplierBookingMode: 'FIXTURE',
    });
    // adapter called BEFORE BEGIN
    const beginIdx = h.calls.indexOf('BEGIN');
    expect(h.book).toHaveBeenCalledTimes(1);
    expect(beginIdx).toBeGreaterThan(-1);
    // order inside tx: RECORD → AUDIT → COMMIT
    const order = h.calls.filter(
      (c) => c === 'RECORD' || c === 'AUDIT' || c === 'COMMIT',
    );
    expect(order).toEqual(['RECORD', 'AUDIT', 'COMMIT']);
  });

  it('builds the BookRequest from the pinned snapshot + guest contact', async () => {
    await h.service.supplierBook(BOOKING_ID);
    const [, req] = h.book.mock.calls[0]!;
    expect(req).toMatchObject({
      supplierHotelId: 'HB-1',
      supplierRateId: 'rk-1',
      supplierRawRef: 'raw-ref-x',
      checkIn: '2026-07-01',
      checkOut: '2026-07-03',
      occupancy: { adults: 2, children: 0 },
      guestFirstName: 'Ada',
      guestEmail: 'ada@x.io',
      idempotencyKey: `supplier-book:${BOOKING_ID}`,
    });
  });

  it('emits BOOKING_SUPPLIER_BOOKED with the documented payload', async () => {
    await h.service.supplierBook(BOOKING_ID);
    const [, event] = h.emitInTransaction.mock.calls[0]!;
    expect(event).toMatchObject({
      category: 'APP',
      kind: 'BOOKING_SUPPLIER_BOOKED',
      tenantId: TENANT_ID,
      targetId: BOOKING_ID,
      payload: {
        bookingId: BOOKING_ID,
        accountId: '01ARZ3NDEKTSV4RRFFQ69G5ACC',
        bookingReference: 'BB-2026-00099',
        supplierRef: 'HOTELBEDS',
        supplierBookingRef: 'HB-FIX-ABCDEF012345',
        supplierStatus: 'CONFIRMED',
        mode: 'FIXTURE',
      },
    });
  });

  it('falls back to the live source snapshot when no pinned snapshot', async () => {
    h.loadBookingTimeOfferSnapshot.mockResolvedValue(undefined);
    h.loadSourceOfferSnapshot.mockResolvedValue({
      ...PINNED,
      id: '01ARZ3NDEKTSV4RRFFQ69G5SRC',
    });
    await h.service.supplierBook(BOOKING_ID);
    expect(h.loadSourceOfferSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      '01ARZ3NDEKTSV4RRFFQ69G5SRC',
    );
    expect(h.book).toHaveBeenCalledTimes(1);
  });
});

describe('BookingSupplierService.supplierBook — guards & failures', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('404 when the booking does not exist', async () => {
    h.loadById.mockResolvedValueOnce(undefined);
    await expect(h.service.supplierBook(BOOKING_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.book).not.toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'FAILED', 'REFUNDED'] as const)(
    'refuses terminal status %s with 422',
    async (status) => {
      h.loadById.mockResolvedValue(record({ status }));
      await expect(
        h.service.supplierBook(BOOKING_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(h.book).not.toHaveBeenCalled();
    },
  );

  it('maps adapter NOT_IMPLEMENTED to 501 and writes nothing', async () => {
    h.book.mockRejectedValue(
      Object.assign(new Error('not impl'), { code: 'NOT_IMPLEMENTED' }),
    );
    await expect(h.service.supplierBook(BOOKING_ID)).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.emitInTransaction).not.toHaveBeenCalled();
  });

  it('a non-NOT_IMPLEMENTED adapter error propagates and writes nothing', async () => {
    h.book.mockRejectedValue(new Error('supplier 500'));
    await expect(h.service.supplierBook(BOOKING_ID)).rejects.toThrow(
      /supplier 500/,
    );
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('rolls back when the audit emit fails', async () => {
    h.emitInTransaction.mockRejectedValue(new Error('audit failed'));
    await expect(h.service.supplierBook(BOOKING_ID)).rejects.toThrow(
      /audit failed/,
    );
    expect(h.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(h.clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });
});

describe('BookingSupplierService.supplierBook — idempotency', () => {
  it('fast-path replay when supplier_confirmation_ref already set', async () => {
    const h = makeHarness();
    h.loadById.mockResolvedValue(
      record({
        supplierConfirmationRef: 'HB-FIX-OLD',
        supplierBookingStatus: 'CONFIRMED',
        supplierBookingMode: 'FIXTURE',
        supplierBookedAt: '2026-05-19T09:00:00.000Z',
        supplierId: '01ARZ3NDEKTSV4RRFFQ69G5SUP',
      }),
    );
    const result = await h.service.supplierBook(BOOKING_ID);
    expect(result.replayed).toBe(true);
    expect(result.booking.supplierConfirmationRef).toBe('HB-FIX-OLD');
    expect(h.book).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.emitInTransaction).not.toHaveBeenCalled();
  });

  it('race: recordSupplierBooking 0 rows but ref now present → replay, no audit', async () => {
    const h = makeHarness();
    h.recordSupplierBooking.mockResolvedValue({ updated: false });
    h.loadById
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(
        record({
          supplierConfirmationRef: 'HB-FIX-WINNER',
          supplierBookingMode: 'FIXTURE',
        }),
      );
    const result = await h.service.supplierBook(BOOKING_ID);
    expect(result.replayed).toBe(true);
    expect(result.booking.supplierConfirmationRef).toBe('HB-FIX-WINNER');
    expect(h.emitInTransaction).not.toHaveBeenCalled();
    expect(h.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('race with no winner → Conflict', async () => {
    const h = makeHarness();
    h.recordSupplierBooking.mockResolvedValue({ updated: false });
    h.loadById
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(record());
    await expect(h.service.supplierBook(BOOKING_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
