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
 * Integration test for POST /internal/bookings/:id/confirm.
 * Boots the real Nest app against the local Postgres stack. Skipped
 * cleanly when DATABASE_URL is absent.
 *
 * Tests use the same-currency confirm path so the resolver short-
 * circuits (no Stripe, no OXR) — the cross-currency / Stripe-mock
 * paths are already covered by the C5c.2 unit and integration tests.
 *
 * Outbound HTTP (Stripe / OXR) is NOT mocked here because none of
 * these tests trigger it: same-currency confirm bypasses the resolver
 * entirely.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('POST /internal/bookings/:id/confirm', () => {
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

  async function seedBooking(opts: {
    status?: 'INITIATED' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';
    sellAmountMinorUnits?: number | null;
    sellCurrency?: string | null;
  } = {}): Promise<string> {
    const tenantId = newUlid();
    const accountId = newUlid();
    const canonicalHotelId = newUlid();
    const bookingId = newUlid();
    const slug = `bkc-${bookingId.slice(-8).toLowerCase()}`;

    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Booking Ctrl Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'Booking Ctrl Test Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1, 'Booking Ctrl Hotel', 'AE')`,
      [canonicalHotelId],
    );
    await pool.query(
      `INSERT INTO booking_booking (
         id, tenant_id, account_id, canonical_hotel_id,
         collection_mode, supplier_settlement_mode, payment_cost_model,
         check_in, check_out, reference, status,
         sell_amount_minor_units, sell_currency
       ) VALUES (
         $1, $2, $3, $4,
         'BB_COLLECTS', 'PREPAID_BALANCE', 'PLATFORM_CARD_FEE',
         '2026-06-01', '2026-06-03', $5, $6,
         $7, $8
       )`,
      [
        bookingId,
        tenantId,
        accountId,
        canonicalHotelId,
        `BB-CTRL-${slug}`,
        opts.status ?? 'INITIATED',
        opts.sellAmountMinorUnits === undefined
          ? 10000
          : opts.sellAmountMinorUnits,
        opts.sellCurrency === undefined ? 'USD' : opts.sellCurrency,
      ],
    );
    return bookingId;
  }

  // ─── Happy path ─────────────────────────────────────────────────────────

  it('confirms an INITIATED booking and returns 201 with NO_LOCK_NEEDED for same-currency', async () => {
    const id = await seedBooking({ sellCurrency: 'USD' });
    const res = await postConfirm(app, id, { chargeCurrency: 'USD' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      bookingId: string;
      alreadyConfirmed: boolean;
      fxOutcome?: { kind: string };
    };
    expect(body.bookingId).toBe(id);
    expect(body.alreadyConfirmed).toBe(false);
    expect(body.fxOutcome).toEqual({ kind: 'NO_LOCK_NEEDED' });

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM booking_booking WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.status).toBe('CONFIRMED');
  });

  it('returns alreadyConfirmed:true on a second confirm (idempotent)', async () => {
    const id = await seedBooking({ sellCurrency: 'USD' });
    await postConfirm(app, id, { chargeCurrency: 'USD' });

    const res = await postConfirm(app, id, { chargeCurrency: 'USD' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { alreadyConfirmed: boolean; fxOutcome?: unknown };
    expect(body.alreadyConfirmed).toBe(true);
    // Idempotent fast-path does not recompute the FX outcome.
    expect(body.fxOutcome).toBeUndefined();
  });

  // ─── Auth ───────────────────────────────────────────────────────────────

  it('returns 401 when x-internal-key header is missing', async () => {
    const id = await seedBooking();
    const url = await urlFor(app.getHttpServer(), `/internal/bookings/${id}/confirm`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chargeCurrency: 'USD' }),
    });
    expect(res.status).toBe(401);
  });

  // ─── Body validation ────────────────────────────────────────────────────

  it('returns 400 when body is not an object', async () => {
    const id = await seedBooking();
    const url = await urlFor(app.getHttpServer(), `/internal/bookings/${id}/confirm`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': TEST_INTERNAL_KEY,
      },
      body: JSON.stringify('hello'),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when chargeCurrency is missing', async () => {
    const id = await seedBooking();
    const res = await postConfirm(app, id, {} as { chargeCurrency: string });
    expect(res.status).toBe(400);
  });

  it('returns 400 when chargeCurrency is not 3-letter uppercase ISO 4217', async () => {
    const id = await seedBooking();
    for (const bad of ['usd', 'US', 'USDA', 'U$D']) {
      const res = await postConfirm(app, id, { chargeCurrency: bad });
      expect(res.status).toBe(400);
    }
  });

  // ─── Domain errors ──────────────────────────────────────────────────────

  it('returns 404 when the booking does not exist', async () => {
    const res = await postConfirm(app, newUlid(), { chargeCurrency: 'USD' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the booking is unpriced (sell_currency is null)', async () => {
    const id = await seedBooking({ sellCurrency: null });
    const res = await postConfirm(app, id, { chargeCurrency: 'EUR' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(JSON.stringify(body)).toMatch(/pricing not pinned/);
  });

  it('returns 400 when the booking is in a terminal state (CANCELLED)', async () => {
    const id = await seedBooking({ status: 'CANCELLED' });
    const res = await postConfirm(app, id, { chargeCurrency: 'USD' });
    expect(res.status).toBe(400);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function postConfirm(
  app: INestApplication,
  bookingId: string,
  body: { chargeCurrency: string },
): Promise<Response> {
  const url = await urlFor(
    app.getHttpServer(),
    `/internal/bookings/${bookingId}/confirm`,
  );
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
