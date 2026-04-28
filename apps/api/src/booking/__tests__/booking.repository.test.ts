import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newUlid } from '../../common/ulid';
import { BookingRepository } from '../booking.repository';
import { BookingService } from '../booking.service';

/**
 * Integration tests for BookingRepository + BookingService against a
 * real Postgres. Skipped cleanly when DATABASE_URL is absent.
 *
 * Each test seeds its own `core_tenant` + `core_account` +
 * `hotel_canonical` + `booking_booking` row so reruns on a live DB
 * stay isolated. No FX rows are touched in this slice.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('BookingRepository + BookingService (real DB)', () => {
  let pool: Pool;
  let repository: BookingRepository;
  let service: BookingService;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    repository = new BookingRepository();
    service = new BookingService(pool, repository);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedBooking(
    initialStatus: 'INITIATED' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED',
  ): Promise<string> {
    const tenantId = newUlid();
    const accountId = newUlid();
    const canonicalHotelId = newUlid();
    const bookingId = newUlid();
    const slug = `bk-${bookingId.slice(-8).toLowerCase()}`;

    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Booking Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'Booking Test Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1, 'Booking Test Hotel', 'AE')`,
      [canonicalHotelId],
    );
    await pool.query(
      `INSERT INTO booking_booking (
         id, tenant_id, account_id, canonical_hotel_id,
         collection_mode, supplier_settlement_mode, payment_cost_model,
         check_in, check_out, reference, status
       ) VALUES (
         $1, $2, $3, $4,
         'BB_COLLECTS', 'PREPAID_BALANCE', 'PLATFORM_CARD_FEE',
         '2026-06-01', '2026-06-03', $5, $6
       )`,
      [bookingId, tenantId, accountId, canonicalHotelId, `BB-CONF-${slug}`, initialStatus],
    );
    return bookingId;
  }

  it('loadById returns undefined for a non-existent booking', async () => {
    const missing = await repository.loadById(pool, newUlid());
    expect(missing).toBeUndefined();
  });

  it('loadById returns the booking with its current status', async () => {
    const id = await seedBooking('INITIATED');
    const record = await repository.loadById(pool, id);
    expect(record).toBeDefined();
    expect(record!.id).toBe(id);
    expect(record!.status).toBe('INITIATED');
  });

  it('confirm flips an INITIATED booking to CONFIRMED', async () => {
    const id = await seedBooking('INITIATED');
    const result = await service.confirm({
      bookingId: id,
      chargeCurrency: 'USD',
    });
    expect(result).toEqual({ bookingId: id, alreadyConfirmed: false });

    const after = await repository.loadById(pool, id);
    expect(after!.status).toBe('CONFIRMED');
  });

  it('confirm flips a PENDING_PAYMENT booking to CONFIRMED', async () => {
    const id = await seedBooking('PENDING_PAYMENT');
    const result = await service.confirm({
      bookingId: id,
      chargeCurrency: 'GBP',
    });
    expect(result.alreadyConfirmed).toBe(false);
    const after = await repository.loadById(pool, id);
    expect(after!.status).toBe('CONFIRMED');
  });

  it('a second confirm on the same booking returns alreadyConfirmed: true (idempotent)', async () => {
    const id = await seedBooking('INITIATED');
    await service.confirm({ bookingId: id, chargeCurrency: 'USD' });
    const second = await service.confirm({ bookingId: id, chargeCurrency: 'USD' });
    expect(second).toEqual({ bookingId: id, alreadyConfirmed: true });
  });

  it('refuses to confirm a CANCELLED booking', async () => {
    const id = await seedBooking('CANCELLED');
    await expect(
      service.confirm({ bookingId: id, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/Cannot confirm.*CANCELLED/);
  });

  it('throws NotFoundException for a missing booking id', async () => {
    await expect(
      service.confirm({ bookingId: newUlid(), chargeCurrency: 'USD' }),
    ).rejects.toThrow(/Booking not found/);
  });
});
