import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { BookingConfirmationService } from '../booking-confirmation.service';
import type {
  BookingHeaderRow,
  DocumentContentRepository,
} from '../document-content.repository';
import type { DocumentRepository } from '../document.repository';
import type { DocumentStorage } from '../document-storage';
import type { AuditService } from '../../audit/audit.service';

const BOOKING_ID = '01ARZ3NDEKTSV4RRFFQ69G5BKG';
const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5TEN';
const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5DOC';

function header(overrides: Partial<BookingHeaderRow> = {}): BookingHeaderRow {
  return {
    id: BOOKING_ID,
    tenant_id: TENANT_ID,
    account_id: '01ARZ3NDEKTSV4RRFFQ69G5ACC',
    reference: 'BB-2026-00099',
    status: 'CONFIRMED',
    check_in: '2026-07-01',
    check_out: '2026-07-04',
    guest_first_name: 'Ada',
    guest_last_name: 'Byron',
    guest_email: 'ada@x.io',
    sell_amount_minor_units: '25000',
    sell_currency: 'USD',
    supplier_ref: 'HOTELBEDS',
    supplier_raw_ref: 'raw-ref-x',
    supplier_confirmation_ref: 'HB-FIX-ABCDEF012345',
    supplier_booking_status: 'CONFIRMED',
    ...overrides,
  };
}

const PINNED_OFFER = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5OFF',
  supplier_id: '01ARZ3NDEKTSV4RRFFQ69G5SUP',
  supplier_hotel_code: 'HB-1',
  supplier_rate_key: 'rk-1',
  canonical_hotel_id: null,
  check_in: '2026-07-01',
  check_out: '2026-07-04',
  occupancy_adults: 2,
  supplier_room_code: 'DBL',
  supplier_rate_code: 'BAR',
  supplier_meal_code: null,
  total_amount_minor_units: '25000',
  total_currency: 'USD',
  rate_breakdown_granularity: 'TOTAL_ONLY',
};

const ISSUED = {
  id: DOC_ID,
  tenantId: TENANT_ID,
  bookingId: BOOKING_ID,
  documentType: 'BB_BOOKING_CONFIRMATION',
  documentNumber: 'BB-CONF-2026-00001',
  status: 'ISSUED',
  objectStorageKey: 'documents/k.json',
  contentHash: 'a'.repeat(64),
  contentSchemaVersion: 1,
  issuedAt: '2026-05-19T10:00:00.000Z',
};

interface Harness {
  service: BookingConfirmationService;
  calls: string[];
  clientQuery: ReturnType<typeof vi.fn>;
  loadBookingHeader: ReturnType<typeof vi.fn>;
  loadPinnedOffer: ReturnType<typeof vi.fn>;
  findByBookingAndType: ReturnType<typeof vi.fn>;
  allocateNumber: ReturnType<typeof vi.fn>;
  insertIssued: ReturnType<typeof vi.fn>;
  putJson: ReturnType<typeof vi.fn>;
  emitInTransaction: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const calls: string[] = [];
  const clientQuery = vi.fn(async (sql: string) => {
    calls.push(sql);
    return { rows: [] };
  });
  const client = {
    query: clientQuery,
    release: vi.fn(),
  } as unknown as PoolClient;
  const connect = vi.fn(async () => {
    calls.push('CONNECT');
    return client;
  });
  const pool = { connect } as unknown as Pool;

  const loadBookingHeader = vi.fn(async () => header());
  const loadPinnedOffer = vi.fn(async () => PINNED_OFFER);
  const loadPinnedComponents = vi.fn(async () => [
    {
      component_kind: 'ROOM_RATE',
      description: 'Room',
      amount_minor_units: '25000',
      currency: 'USD',
      applies_to_night_date: null,
      applies_to_person_kind: null,
      inclusive: false,
    },
  ]);
  const loadPinnedCancellationPolicy = vi.fn(async () => ({
    windows_jsonb: [],
    refundable: true,
    source_verbatim_text: 'free cxl',
    parsed_with: 'v1',
  }));
  const loadPinnedTaxFees = vi.fn(async () => []);
  const contentRepo = {
    loadBookingHeader,
    loadPinnedOffer,
    loadPinnedComponents,
    loadPinnedCancellationPolicy,
    loadPinnedTaxFees,
  } as unknown as DocumentContentRepository;

  const findByBookingAndType = vi.fn(async () => undefined);
  const allocateNumber = vi.fn(async () => {
    calls.push('ALLOCATE');
    return { sequenceId: '01ARZ3NDEKTSV4RRFFQ69G5SEQ', allocatedNumber: 1 };
  });
  const insertIssued = vi.fn(async () => {
    calls.push('INSERT');
    return ISSUED;
  });
  const documentRepo = {
    findByBookingAndType,
    allocateNumber,
    insertIssued,
  } as unknown as DocumentRepository;

  const putJson = vi.fn(async () => {
    calls.push('PUTJSON');
    return {
      objectStorageKey: 'documents/k.json',
      contentHash: 'a'.repeat(64),
      bytes: 123,
    };
  });
  const storage = { putJson } as unknown as DocumentStorage;

  const emitInTransaction = vi.fn(async () => {
    calls.push('AUDIT');
  });
  const auditService = { emitInTransaction } as unknown as AuditService;

  const service = new BookingConfirmationService(
    pool,
    contentRepo,
    documentRepo,
    storage,
    auditService,
  );
  return {
    service,
    calls,
    clientQuery,
    loadBookingHeader,
    loadPinnedOffer,
    findByBookingAndType,
    allocateNumber,
    insertIssued,
    putJson,
    emitInTransaction,
    connect,
  };
}

describe('BookingConfirmationService.issue — happy path', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('issues a BB_BOOKING_CONFIRMATION and returns the view', async () => {
    const res = await h.service.issue({ bookingId: BOOKING_ID });
    expect(res.replayed).toBe(false);
    expect(res.document).toMatchObject({
      id: DOC_ID,
      bookingId: BOOKING_ID,
      documentType: 'BB_BOOKING_CONFIRMATION',
      status: 'ISSUED',
      contentSchemaVersion: 1,
    });
  });

  it('writes the blob BEFORE BEGIN, then allocate→insert→audit→commit', async () => {
    await h.service.issue({ bookingId: BOOKING_ID });
    const putIdx = h.calls.indexOf('PUTJSON');
    const beginIdx = h.calls.indexOf('BEGIN');
    expect(putIdx).toBeGreaterThan(-1);
    expect(putIdx).toBeLessThan(beginIdx);
    const order = h.calls.filter((c) =>
      ['ALLOCATE', 'INSERT', 'AUDIT', 'COMMIT'].includes(c),
    );
    expect(order).toEqual(['ALLOCATE', 'INSERT', 'AUDIT', 'COMMIT']);
  });

  it('records content hash + object key from storage on the row', async () => {
    await h.service.issue({ bookingId: BOOKING_ID });
    const insertArg = h.insertIssued.mock.calls[0]![1];
    expect(insertArg).toMatchObject({
      objectStorageKey: 'documents/k.json',
      contentHash: 'a'.repeat(64),
      contentSchemaVersion: 1,
      documentType: 'BB_BOOKING_CONFIRMATION',
    });
    expect(insertArg.documentNumber).toMatch(/^BB-CONF-\d{4}-\d{5}$/);
  });

  it('emits BOOKING_DOCUMENT_CREATED with the documented payload', async () => {
    await h.service.issue({ bookingId: BOOKING_ID });
    const [, event] = h.emitInTransaction.mock.calls[0]!;
    expect(event).toMatchObject({
      category: 'APP',
      kind: 'BOOKING_DOCUMENT_CREATED',
      tenantId: TENANT_ID,
      targetId: BOOKING_ID,
      payload: {
        documentId: DOC_ID,
        bookingId: BOOKING_ID,
        tenantId: TENANT_ID,
        documentType: 'BB_BOOKING_CONFIRMATION',
        status: 'ISSUED',
        contentHash: 'a'.repeat(64),
        objectStorageKey: 'documents/k.json',
        sequenceId: '01ARZ3NDEKTSV4RRFFQ69G5SEQ',
        allocatedNumber: '1',
      },
    });
  });

  it('builds content only from pinned snapshots (no live supply reads)', async () => {
    await h.service.issue({ bookingId: BOOKING_ID });
    const content = h.putJson.mock.calls[0]![0].content as Record<
      string,
      unknown
    >;
    expect(content).toMatchObject({
      documentType: 'BB_BOOKING_CONFIRMATION',
      contentSchemaVersion: 1,
    });
    expect((content.booking as Record<string, unknown>).reference).toBe(
      'BB-2026-00099',
    );
    expect(
      (content.sourceOffer as Record<string, unknown>).supplierHotelCode,
    ).toBe('HB-1');
  });
});

describe('BookingConfirmationService.issue — guards', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('400 on a non-object body', async () => {
    await expect(h.service.issue('nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400 on a missing/invalid bookingId', async () => {
    await expect(h.service.issue({ bookingId: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404 when the booking does not exist', async () => {
    h.loadBookingHeader.mockResolvedValueOnce(undefined);
    await expect(
      h.service.issue({ bookingId: BOOKING_ID }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.putJson).not.toHaveBeenCalled();
  });

  it.each(['INITIATED', 'PENDING_PAYMENT', 'CANCELLED'] as const)(
    'refuses non-CONFIRMED status %s with 422',
    async (status) => {
      h.loadBookingHeader.mockResolvedValue(header({ status }));
      await expect(
        h.service.issue({ bookingId: BOOKING_ID }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(h.putJson).not.toHaveBeenCalled();
    },
  );

  it('refuses a booking with no pinned offer snapshot (422)', async () => {
    h.loadPinnedOffer.mockResolvedValueOnce(undefined);
    await expect(
      h.service.issue({ bookingId: BOOKING_ID }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.putJson).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe('BookingConfirmationService.issue — failures roll back', () => {
  it('audit failure rolls back, no COMMIT', async () => {
    const h = makeHarness();
    h.emitInTransaction.mockRejectedValue(new Error('audit failed'));
    await expect(
      h.service.issue({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/audit failed/);
    expect(h.clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(h.clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('storage failure throws before any DB tx', async () => {
    const h = makeHarness();
    h.putJson.mockRejectedValue(new Error('s3 down'));
    await expect(
      h.service.issue({ bookingId: BOOKING_ID }),
    ).rejects.toThrow(/s3 down/);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.allocateNumber).not.toHaveBeenCalled();
  });
});

describe('BookingConfirmationService.issue — idempotency', () => {
  it('fast-path replay returns existing, no number/blob/audit', async () => {
    const h = makeHarness();
    h.findByBookingAndType.mockResolvedValue(ISSUED);
    const res = await h.service.issue({ bookingId: BOOKING_ID });
    expect(res.replayed).toBe(true);
    expect(res.document.id).toBe(DOC_ID);
    expect(h.putJson).not.toHaveBeenCalled();
    expect(h.allocateNumber).not.toHaveBeenCalled();
    expect(h.emitInTransaction).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('insert unique-violation race → rollback, replay winner, no audit', async () => {
    const h = makeHarness();
    h.findByBookingAndType
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(ISSUED);
    h.insertIssued.mockRejectedValue(
      Object.assign(new Error('dup'), {
        code: '23505',
        constraint: 'doc_booking_document_bk_type_uq',
      }),
    );
    const res = await h.service.issue({ bookingId: BOOKING_ID });
    expect(res.replayed).toBe(true);
    expect(res.document.id).toBe(DOC_ID);
    expect(h.emitInTransaction).not.toHaveBeenCalled();
    expect(h.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
