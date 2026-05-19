import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { newUlid } from '../../common/ulid';
import { DatabaseModule } from '../../database/database.module';
import { BookingModule } from '../booking.module';

/**
 * Integration test for POST /internal/bookings (Booking Intake) and the
 * create → confirm handoff. Boots the real Nest app against the local
 * Postgres stack. Skipped cleanly when DATABASE_URL is absent.
 *
 * The create → confirm test proves the pre-existing
 * POST /internal/bookings/:id/confirm endpoint is no longer dead code:
 * an intake-created INITIATED booking is confirmable end-to-end. No
 * real supplier book() is called anywhere in this slice.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('POST /internal/bookings (Booking Intake)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, BookingModule],
    }).compile();
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
  }> {
    const tenantId = newUlid();
    const accountId = newUlid();
    const hotelId = newUlid();
    const slug = `bki-${tenantId.slice(-8).toLowerCase()}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Booking Intake Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'Booking Intake Test Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1, 'Booking Intake Hotel', 'AE')`,
      [hotelId],
    );
    return { tenantId, accountId, hotelId };
  }

  function intakeBody(
    scope: { tenantId: string; accountId: string; hotelId: string },
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      canonicalHotelId: scope.hotelId,
      sourceOfferSnapshotId: newUlid(),
      supplier: 'HOTELBEDS',
      supplierRawRef: 'raw-ref-int-1',
      checkIn: '2026-07-01',
      checkOut: '2026-07-04',
      occupancy: { adults: 2 },
      guestDetails: { firstName: 'Ada', lastName: 'Byron', email: 'ada@x.io' },
      sellAmountMinorUnits: 25000,
      sellCurrency: 'USD',
      moneyMovement: {
        collectionMode: 'BB_COLLECTS',
        supplierSettlementMode: 'PREPAID_BALANCE',
        paymentCostModel: 'PLATFORM_CARD_FEE',
      },
      idempotencyKey: `idem-${newUlid()}`,
      ...overrides,
    };
  }

  // ─── Happy path + response shape ────────────────────────────────────────

  it('creates an INITIATED booking and returns 201 with the documented shape', async () => {
    const scope = await seedScope();
    const res = await postIntake(app, intakeBody(scope));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      booking: Record<string, unknown>;
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    expect(body.booking).toMatchObject({
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      status: 'INITIATED',
      supplier: 'HOTELBEDS',
      supplierRawRef: 'raw-ref-int-1',
      sellAmountMinorUnits: 25000,
      sellCurrency: 'USD',
      checkIn: '2026-07-01',
      checkOut: '2026-07-04',
    });
    expect(body.booking['reference']).toMatch(/^BB-\d{4}-\d{5}$/);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM booking_booking WHERE id = $1`,
      [body.booking['id']],
    );
    expect(rows[0]!.status).toBe('INITIATED');
  });

  it('writes a durable BOOKING_CREATED audit event', async () => {
    const scope = await seedScope();
    const res = await postIntake(app, intakeBody(scope));
    const body = (await res.json()) as { booking: { id: string } };
    const { rows } = await pool.query<{ kind: string; category: string }>(
      `SELECT kind, category FROM audit_event
        WHERE target_id = $1 AND kind = 'BOOKING_CREATED'`,
      [body.booking.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'BOOKING_CREATED',
      category: 'APP',
    });
  });

  // ─── Idempotency ────────────────────────────────────────────────────────

  it('replays the same booking for a repeated idempotencyKey', async () => {
    const scope = await seedScope();
    const body = intakeBody(scope);
    const first = await (await postIntake(app, body)).json();
    const second = await postIntake(app, body);
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as {
      booking: { id: string };
      replayed: boolean;
    };
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.booking.id).toBe(
      (first as { booking: { id: string } }).booking.id,
    );
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_event
        WHERE target_id = $1 AND kind = 'BOOKING_CREATED'`,
      [secondBody.booking.id],
    );
    expect(rows[0]!.count).toBe('1');
  });

  // ─── Create → confirm handoff (confirm is no longer dead code) ──────────

  it('an intake-created booking can be confirmed via the existing confirm endpoint', async () => {
    const scope = await seedScope();
    const created = (await (
      await postIntake(app, intakeBody(scope))
    ).json()) as { booking: { id: string } };

    const confirmUrl = await urlFor(
      app.getHttpServer(),
      `/internal/bookings/${created.booking.id}/confirm`,
    );
    const confirmRes = await fetch(confirmUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ chargeCurrency: 'USD' }),
    });
    expect(confirmRes.status).toBe(201);
    const confirmBody = (await confirmRes.json()) as {
      bookingId: string;
      alreadyConfirmed: boolean;
    };
    expect(confirmBody.bookingId).toBe(created.booking.id);
    expect(confirmBody.alreadyConfirmed).toBe(false);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM booking_booking WHERE id = $1`,
      [created.booking.id],
    );
    expect(rows[0]!.status).toBe('CONFIRMED');
  });

  // ─── Auth + validation ──────────────────────────────────────────────────

  it('returns 401 when x-internal-key is missing', async () => {
    const scope = await seedScope();
    const url = await urlFor(app.getHttpServer(), '/internal/bookings');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intakeBody(scope)),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when pricing is not pinned', async () => {
    const scope = await seedScope();
    const res = await postIntake(
      app,
      intakeBody(scope, { sellAmountMinorUnits: undefined }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 422 for a PROVISIONAL rate', async () => {
    const scope = await seedScope();
    const res = await postIntake(
      app,
      intakeBody(scope, { moneyMovementProvenance: 'PROVISIONAL' }),
    );
    expect(res.status).toBe(422);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function postIntake(
  app: INestApplication,
  body: unknown,
): Promise<Response> {
  const url = await urlFor(app.getHttpServer(), '/internal/bookings');
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': TEST_INTERNAL_KEY,
    },
    body: JSON.stringify(body),
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
