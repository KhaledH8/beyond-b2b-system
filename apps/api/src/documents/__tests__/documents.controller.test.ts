import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { newUlid } from '../../common/ulid';
import { DatabaseModule } from '../../database/database.module';
import { BookingModule } from '../../booking/booking.module';
import { DocumentsModule } from '../documents.module';
import { SupplierAdapterRegistry } from '../../adapters/adapter-registry';
import { S3_CLIENT } from '../../object-storage/object-storage.module';

/**
 * Integration test for POST /internal/documents/booking-confirmation
 * plus the full intake → confirm → supplier-book → issue path. Real
 * Nest + Postgres; the supplier adapter registry is a deterministic
 * fixture fake and S3 is an in-memory fake (no MinIO/Hotelbeds env).
 * Skipped cleanly when DATABASE_URL is absent.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const d = HAS_DATABASE ? describe : describe.skip;

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

interface StoredObject {
  key: string;
  body: Buffer;
}

class FakeS3 {
  readonly puts: StoredObject[] = [];
  async send(cmd: { input: { Key: string; Body: Buffer | Uint8Array } }) {
    this.puts.push({
      key: cmd.input.Key,
      body: Buffer.from(cmd.input.Body),
    });
    return {};
  }
}

d('POST /internal/documents/booking-confirmation', () => {
  let app: INestApplication;
  let pool: Pool;
  let s3: FakeS3;

  beforeAll(async () => {
    process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    s3 = new FakeS3();
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, BookingModule, DocumentsModule],
    })
      .overrideProvider(SupplierAdapterRegistry)
      .useValue(fakeRegistry)
      .overrideProvider(S3_CLIENT)
      .useValue(s3)
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
    const slug = `dci-${tenantId.slice(-8).toLowerCase()}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1,$2,$3)`,
      [tenantId, slug, `DCI ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1,$2,'AGENCY','DCI Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1,'DCI Hotel','AE')`,
      [hotelId],
    );
    await pool.query(
      `INSERT INTO supply_supplier (id, code, display_name, source_type)
         VALUES ($1,$2,'DCI Supplier','AGGREGATOR')`,
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

  async function intakeConfirmSupplierBook(scope: {
    tenantId: string;
    accountId: string;
    hotelId: string;
    sourceOfferSnapshotId: string;
  }): Promise<string> {
    const intake = await post(app, '/internal/bookings', {
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      canonicalHotelId: scope.hotelId,
      sourceOfferSnapshotId: scope.sourceOfferSnapshotId,
      supplier: 'HOTELBEDS',
      supplierRawRef: 'raw-ref-doc',
      checkIn: '2026-07-01',
      checkOut: '2026-07-04',
      occupancy: { adults: 2 },
      guestDetails: {
        guest: { firstName: 'Ada', lastName: 'Byron', email: 'a@b.io' },
      },
      sellAmountMinorUnits: 25000,
      sellCurrency: 'USD',
      moneyMovement: {
        collectionMode: 'BB_COLLECTS',
        supplierSettlementMode: 'PREPAID_BALANCE',
        paymentCostModel: 'PLATFORM_CARD_FEE',
      },
      idempotencyKey: `idem-${newUlid()}`,
    });
    const bookingId = (
      (await intake.json()) as { booking: { id: string } }
    ).booking.id;
    await post(app, `/internal/bookings/${bookingId}/confirm`, {
      chargeCurrency: 'USD',
    });
    await post(app, `/internal/bookings/${bookingId}/supplier-book`);
    return bookingId;
  }

  it('issues a BB_BOOKING_CONFIRMATION; blob, hash, audit all line up', async () => {
    const scope = await seedScope();
    const bookingId = await intakeConfirmSupplierBook(scope);

    const res = await post(
      app,
      '/internal/documents/booking-confirmation',
      { bookingId },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      document: Record<string, unknown>;
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    expect(body.document).toMatchObject({
      bookingId,
      documentType: 'BB_BOOKING_CONFIRMATION',
      status: 'ISSUED',
      contentSchemaVersion: 1,
    });
    expect(body.document['documentNumber']).toMatch(
      /^BB-CONF-\d{4}-\d{5}$/,
    );

    const row = await pool.query<{
      content_hash: string;
      object_storage_key: string;
    }>(
      `SELECT content_hash, object_storage_key
         FROM doc_booking_document WHERE booking_id = $1`,
      [bookingId],
    );
    expect(row.rows).toHaveLength(1);
    const stored = s3.puts.find(
      (p) => p.key === row.rows[0]!.object_storage_key,
    );
    expect(stored).toBeDefined();
    const blobHash = createHash('sha256')
      .update(stored!.body)
      .digest('hex');
    expect(blobHash).toBe(row.rows[0]!.content_hash);

    const content = JSON.parse(stored!.body.toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(content['documentType']).toBe('BB_BOOKING_CONFIRMATION');
    expect(
      (content['booking'] as Record<string, unknown>)['supplierConfirmationRef'],
    ).toMatch(/^HB-FIX-/);

    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_event
        WHERE target_id = $1 AND kind = 'BOOKING_DOCUMENT_CREATED'`,
      [bookingId],
    );
    expect(audit.rows[0]!.count).toBe('1');
  });

  it('replay returns the same document, no new number/blob/audit', async () => {
    const scope = await seedScope();
    const bookingId = await intakeConfirmSupplierBook(scope);
    const first = await post(
      app,
      '/internal/documents/booking-confirmation',
      { bookingId },
    );
    const firstDoc = (
      (await first.json()) as { document: { id: string } }
    ).document;
    const blobsBefore = s3.puts.length;

    const res = await post(
      app,
      '/internal/documents/booking-confirmation',
      { bookingId },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      document: { id: string };
      replayed: boolean;
    };
    expect(body.replayed).toBe(true);
    expect(body.document.id).toBe(firstDoc.id);
    expect(s3.puts.length).toBe(blobsBefore);

    const docs = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM doc_booking_document
        WHERE booking_id = $1`,
      [bookingId],
    );
    expect(docs.rows[0]!.count).toBe('1');
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_event
        WHERE target_id = $1 AND kind = 'BOOKING_DOCUMENT_CREATED'`,
      [bookingId],
    );
    expect(audit.rows[0]!.count).toBe('1');
  });

  it('422 when the booking is not CONFIRMED', async () => {
    const scope = await seedScope();
    const intake = await post(app, '/internal/bookings', {
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      canonicalHotelId: scope.hotelId,
      sourceOfferSnapshotId: scope.sourceOfferSnapshotId,
      supplier: 'HOTELBEDS',
      supplierRawRef: 'raw-ref-doc',
      checkIn: '2026-07-01',
      checkOut: '2026-07-04',
      occupancy: { adults: 2 },
      guestDetails: {
        guest: { firstName: 'A', lastName: 'B', email: 'a@b.io' },
      },
      sellAmountMinorUnits: 25000,
      sellCurrency: 'USD',
      moneyMovement: {
        collectionMode: 'BB_COLLECTS',
        supplierSettlementMode: 'PREPAID_BALANCE',
        paymentCostModel: 'PLATFORM_CARD_FEE',
      },
      idempotencyKey: `idem-${newUlid()}`,
    });
    const bookingId = (
      (await intake.json()) as { booking: { id: string } }
    ).booking.id;
    const res = await post(
      app,
      '/internal/documents/booking-confirmation',
      { bookingId },
    );
    expect(res.status).toBe(422);
  });

  it('404 for an unknown booking', async () => {
    const res = await post(
      app,
      '/internal/documents/booking-confirmation',
      { bookingId: newUlid() },
    );
    expect(res.status).toBe(404);
  });

  it('400 for a malformed body', async () => {
    const res = await post(
      app,
      '/internal/documents/booking-confirmation',
      { nope: true },
    );
    expect(res.status).toBe(400);
  });

  it('401 without the internal key', async () => {
    const url = await urlFor(
      app.getHttpServer(),
      '/internal/documents/booking-confirmation',
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookingId: newUlid() }),
    });
    expect(res.status).toBe(401);
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
