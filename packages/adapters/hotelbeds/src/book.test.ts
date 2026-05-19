import { describe, expect, it } from 'vitest';
import type { BookRequest } from '@bb/supplier-contract';
import { HotelbedsAdapter, type HotelbedsAdapterDeps } from './adapter';
import { createStubHotelbedsClient } from './client';
import { createFixtureHotelbedsClient } from './fixture-client';
import { createLiveHotelbedsClient } from './live-client';
import type { HotelbedsBookRequest } from './client';

/**
 * Slice 3 — fixture-only supplier booking. Stub and live clients must
 * keep refusing `book()` so a live supplier reservation is impossible.
 */

const FIXTURES = {
  hotelsResponse: { hotels: [] },
  availabilityResponse: { hotels: [] },
} as unknown as Parameters<typeof createFixtureHotelbedsClient>[0];

const bookReq: HotelbedsBookRequest = {
  supplierHotelCode: 'HB-1',
  supplierRateKey: 'rk-1',
  supplierRawRef: 'raw-1',
  checkIn: '2026-07-01',
  checkOut: '2026-07-03',
  occupancyAdults: 2,
  guestFirstName: 'Ada',
  guestLastName: 'Byron',
  guestEmail: 'ada@x.io',
  idempotencyKey: 'supplier-book:01ARZ3NDEKTSV4RRFFQ69G5BKG',
};

describe('Hotelbeds fixture client · book()', () => {
  it('returns a deterministic CONFIRMED HB-FIX ref', async () => {
    const client = createFixtureHotelbedsClient(FIXTURES);
    const r = await client.book(bookReq);
    expect(r.status).toBe('CONFIRMED');
    expect(r.supplierBookingRef).toMatch(/^HB-FIX-[0-9A-F]{12}$/);
    expect(() => new Date(r.confirmedAt).toISOString()).not.toThrow();
  });

  it('is idempotent for the same idempotencyKey, varies otherwise', async () => {
    const client = createFixtureHotelbedsClient(FIXTURES);
    const a = await client.book(bookReq);
    const b = await client.book(bookReq);
    const c = await client.book({ ...bookReq, idempotencyKey: 'other' });
    expect(a.supplierBookingRef).toBe(b.supplierBookingRef);
    expect(c.supplierBookingRef).not.toBe(a.supplierBookingRef);
  });
});

describe('Hotelbeds stub/live client · book() refused', () => {
  it('stub client book() throws NOT_IMPLEMENTED', async () => {
    const client = createStubHotelbedsClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://x',
      requestTimeoutMs: 1000,
    });
    await expect(client.book(bookReq)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('live client book() throws NOT_IMPLEMENTED (no HTTP)', async () => {
    const client = createLiveHotelbedsClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://api.test.hotelbeds.com',
      requestTimeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    });
    await expect(client.book(bookReq)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });
});

describe('HotelbedsAdapter.book / cancel', () => {
  function adapterWith(client: HotelbedsAdapterDeps['client']): HotelbedsAdapter {
    return new HotelbedsAdapter({
      client,
    } as unknown as HotelbedsAdapterDeps);
  }

  const contractReq: BookRequest = {
    supplierHotelId: 'HB-1',
    supplierRateId: 'rk-1',
    supplierRawRef: 'raw-1',
    checkIn: '2026-07-01',
    checkOut: '2026-07-03',
    occupancy: { adults: 2, children: 0 },
    guestFirstName: 'Ada',
    guestLastName: 'Byron',
    guestEmail: 'ada@x.io',
    idempotencyKey: 'supplier-book:01ARZ3NDEKTSV4RRFFQ69G5BKG',
  };

  it('delegates book() to the fixture client and maps to BookConfirmation', async () => {
    const adapter = adapterWith(createFixtureHotelbedsClient(FIXTURES));
    const r = await adapter.book({ tenantId: 't' }, contractReq);
    expect(r.status).toBe('CONFIRMED');
    expect(r.supplierBookingRef).toMatch(/^HB-FIX-[0-9A-F]{12}$/);
    expect(r.confirmedAt).toBeInstanceOf(Date);
  });

  it('book() rejects NOT_IMPLEMENTED when the client is stub', async () => {
    const adapter = adapterWith(
      createStubHotelbedsClient({
        apiKey: 'k',
        apiSecret: 's',
        baseUrl: 'https://x',
        requestTimeoutMs: 1000,
      }),
    );
    await expect(
      adapter.book({ tenantId: 't' }, contractReq),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('cancel() remains not implemented', async () => {
    const adapter = adapterWith(createFixtureHotelbedsClient(FIXTURES));
    await expect(
      adapter.cancel(
        { tenantId: 't' },
        { supplierBookingRef: 'HB-FIX-1', idempotencyKey: 'k' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});
