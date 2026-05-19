import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { newUlid } from '../../common/ulid';
import { DatabaseModule } from '../../database/database.module';
import { BookingModule } from '../booking.module';
import { SupplierAdapterRegistry } from '../../adapters/adapter-registry';

/**
 * Integration test for POST /internal/bookings/:id/supplier-book.
 * Real Nest + Postgres; the supplier adapter registry is overridden
 * with a deterministic fixture fake so no Hotelbeds env/HTTP is
 * needed. Skipped cleanly when DATABASE_URL is absent.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

// Deterministic fixture adapter — book() echoes a stable ref derived
// from the idempotency key; no network, no fixture files.
const fakeRegistry = {
  get: () => ({
    book: async (
      _ctx: { tenantId: string },
      req: { idempotencyKey: string },
    ) => ({
      supplierBookingRef: `HB-FIX-${req.idempotencyKey.slice(-12)}`,
      status: 'CONFIRMED' as const,
      confirmedAt: new Date(),
    }),
  }),
};

describeIntegration('POST /internal/bookings/:id/supplier-book', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, BookingModule],
    })
      .overrideProvider(SupplierAdapterRegistry)
      .useValue(fakeRegistry)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  async function seedScope(): Promise<{
    tenantId: string;
    accountId: string;
    hotelId: string;
    sourceOfferSnapshotId: string;
  }> {
    const tenantId = newUlid();
    const accountId = newUlid();
    const hotelId = newUlid();
    const supplierId = newUlid();
    const sourceOfferSnapshotId = newUlid();
    const slug = `bks-${tenantId.slice(-8).toLowerCase()}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1,$2,$3)`,
      [tenantId, slug, `Sup Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1,$2,'AGENCY','Sup Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1,'Sup Hotel','AE')`,
      [hotelId],
    );
    await pool.query(
      `INSERT INTO supply_supplier (id, code, display_name, source_type)
         VALUES ($1,$2,'Sup Supplier','AGGREGATOR')`,
      [supplierId, `sup-${slug}`],
    );
    await pool.query(
      `INSERT INTO offer_sourced_snapshot (
         id, tenant_id, supplier_id, canonical_hotel_id,
         supplier_hotel_code, supplier_rate_key, search_session_id,
         check_in, check_out, occupancy_adults,
         supplier_room_code, supplier_rate_code,
         total_amount_minor_units, total_currency,
         rate_breakdown_granularity, valid_until,
         raw_payload_hash, raw_payload_storage_ref
       ) VALUES (
         $1,$2,$3,$4,'HB','rk',$5,
         '2026-07-01','2026-07-04',2,'DBL','BAR',
         25000,'USD','TOTAL_ONLY', now() + interval '1 hour',
         $6,'s3://r'
       )`,
      [
        sourceOfferSnapshotId,
        tenantId,
        supplierId,
        hotelId,
        newUlid(),
        'a'.repeat(64),
      ],
    );
    await pool.query(
      `INSERT INTO offer_sourced_component (
         id, offer_snapshot_id, component_kind, description,
         amount_minor_units, currency, inclusive
       ) VALUES ($1,$2,'ROOM_RATE','Room',25000,'USD',FALSE)`,
      [newUlid(), sourceOfferSnapshotId],
    );
    return { tenantId, accountId, hotelId, sourceOfferSnapshotId };
  }

  async function createBooking(scope: {
    tenantId: string;
    accountId: string;
    hotelId: string;
    sourceOfferSnapshotId: string;
  }): Promise<string> {
    const res = await post(app, '/internal/bookings', {
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      canonicalHotelId: scope.hotelId,
      sourceOfferSnapshotId: scope.sourceOfferSnapshotId,
      supplier: 'HOTELBEDS',
      supplierRawRef: 'raw-ref-int',
      checkIn: '2026-07-01',
      checkOut: '2026-07-04',
      occupancy: { adults: 2 },
      guestDetails: { firstName: 'Ada', lastName: 'Byron', email: 'a@b.io' },
      sellAmountMinorUnits: 25000,
      sellCurrency: 'USD',
      moneyMovement: {
        collectionMode: 'BB_COLLECTS',
        supplierSettlementMode: 'PREPAID_BALANCE',
        paymentCostModel: 'PLATFORM_CARD_FEE',
      },
      idempotencyKey: `idem-${newUlid()}`,
    });
    const body = (await res.json()) as { booking: { id: string } };
    return body.booking.id;
  }

  it('records a fixture supplier confirmation + BOOKING_SUPPLIER_BOOKED, no status change', async () => {
    const scope = await seedScope();
    const bookingId = await createBooking(scope);

    const res = await post(
      app,
      `/internal/bookings/${bookingId}/supplier-book`,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      booking: Record<string, unknown>;
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    expect(body.booking).toMatchObject({
      id: bookingId,
      status: 'INITIATED', // unchanged
      supplierBookingStatus: 'CONFIRMED',
      supplierBookingMode: 'FIXTURE',
    });
    expect(body.booking['supplierConfirmationRef']).toMatch(/^HB-FIX-/);

    const row = await pool.query<{
      status: string;
      supplier_confirmation_ref: string;
      supplier_booking_mode: string;
      supplier_booked_at: string;
    }>(
      `SELECT status, supplier_confirmation_ref, supplier_booking_mode,
              supplier_booked_at
         FROM booking_booking WHERE id = $1`,
      [bookingId],
    );
    expect(row.rows[0]!.status).toBe('INITIATED');
    expect(row.rows[0]!.supplier_booking_mode).toBe('FIXTURE');
    expect(row.rows[0]!.supplier_booked_at).not.toBeNull();

    const audit = await pool.query<{ kind: string }>(
      `SELECT kind FROM audit_event
        WHERE target_id = $1 AND kind = 'BOOKING_SUPPLIER_BOOKED'`,
      [bookingId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('replays without a second audit event', async () => {
    const scope = await seedScope();
    const bookingId = await createBooking(scope);
    await post(app, `/internal/bookings/${bookingId}/supplier-book`);
    const res = await post(
      app,
      `/internal/bookings/${bookingId}/supplier-book`,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { replayed: boolean };
    expect(body.replayed).toBe(true);
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_event
        WHERE target_id = $1 AND kind = 'BOOKING_SUPPLIER_BOOKED'`,
      [bookingId],
    );
    expect(audit.rows[0]!.count).toBe('1');
  });

  it('confirm still works independently after supplier-book (3 audit kinds)', async () => {
    const scope = await seedScope();
    const bookingId = await createBooking(scope);
    await post(app, `/internal/bookings/${bookingId}/supplier-book`);

    const confirmRes = await postJson(
      app,
      `/internal/bookings/${bookingId}/confirm`,
      { chargeCurrency: 'USD' },
    );
    expect(confirmRes.status).toBe(201);
    const status = await pool.query<{ status: string }>(
      `SELECT status FROM booking_booking WHERE id = $1`,
      [bookingId],
    );
    expect(status.rows[0]!.status).toBe('CONFIRMED');

    const kinds = await pool.query<{ kind: string }>(
      `SELECT kind FROM audit_event
        WHERE target_id = $1
          AND kind IN ('BOOKING_CREATED','BOOKING_SUPPLIER_BOOKED','BOOKING_CONFIRMED')
        ORDER BY kind`,
      [bookingId],
    );
    expect(kinds.rows.map((r) => r.kind)).toEqual([
      'BOOKING_CONFIRMED',
      'BOOKING_CREATED',
      'BOOKING_SUPPLIER_BOOKED',
    ]);
  });

  it('401 without the internal key', async () => {
    const scope = await seedScope();
    const bookingId = await createBooking(scope);
    const url = await urlFor(
      app.getHttpServer(),
      `/internal/bookings/${bookingId}/supplier-book`,
    );
    const res = await fetch(url, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('404 for an unknown booking', async () => {
    const res = await post(
      app,
      `/internal/bookings/${newUlid()}/supplier-book`,
    );
    expect(res.status).toBe(404);
  });
});

async function post(
  app: INestApplication,
  p: string,
  body?: unknown,
): Promise<Response> {
  const url = await urlFor(app.getHttpServer(), p);
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': TEST_INTERNAL_KEY,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function postJson(
  app: INestApplication,
  p: string,
  body: unknown,
): Promise<Response> {
  return post(app, p, body);
}

async function urlFor(_server: unknown, p: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = _server as any;
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, resolve));
  }
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}${p}`;
}
