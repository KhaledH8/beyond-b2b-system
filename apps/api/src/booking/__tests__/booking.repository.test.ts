import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { newUlid } from '../../common/ulid';
import { BookingRepository } from '../booking.repository';
import { BookingService } from '../booking.service';
import {
  BookingFxLockRepository,
} from '../../fx/booking-fx-lock.repository';
import type {
  BookingFxLockDecision,
  BookingFxLockResolver,
} from '../../fx/booking-fx-lock.resolver';

/**
 * Integration tests for BookingRepository + BookingService against a
 * real Postgres. Skipped cleanly when DATABASE_URL is absent.
 *
 * The booking-fx-lock repository runs against the real DB (it only
 * issues SQL); the resolver is stubbed per-test because it would
 * otherwise need real Stripe credentials and a populated
 * fx_rate_snapshot table to exercise its branches. Each test that
 * needs a different decision plugs in its own stub.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('BookingRepository + BookingService (real DB)', () => {
  let pool: Pool;
  let repository: BookingRepository;
  let lockRepository: BookingFxLockRepository;

  // Resolver is replaced per-test via `setResolverDecision`.
  let resolverDecision: BookingFxLockDecision | (() => Promise<never>);
  const stubResolver: BookingFxLockResolver = {
    resolve: vi.fn(async () => {
      if (typeof resolverDecision === 'function') {
        return resolverDecision();
      }
      return resolverDecision;
    }),
  } as unknown as BookingFxLockResolver;

  function setResolverDecision(
    d: BookingFxLockDecision | (() => Promise<never>),
  ): void {
    resolverDecision = d;
  }

  function makeService(): BookingService {
    return new BookingService(pool, repository, stubResolver, lockRepository);
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    repository = new BookingRepository();
    lockRepository = new BookingFxLockRepository();
    // Default: any unexpected resolver call fails the test loudly.
    setResolverDecision(async () => {
      throw new Error('resolver was not expected to be called in this test');
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedBooking(opts: {
    status: 'INITIATED' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';
    sellAmountMinorUnits?: number | null;
    sellCurrency?: string | null;
  }): Promise<string> {
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
        `BB-CONF-${slug}`,
        opts.status,
        // `??` coalesces both null and undefined; we need to honour an
        // explicit null (the policy-violation tests) vs an unset opt.
        opts.sellAmountMinorUnits === undefined
          ? 10000
          : opts.sellAmountMinorUnits,
        opts.sellCurrency === undefined ? 'USD' : opts.sellCurrency,
      ],
    );
    return bookingId;
  }

  async function seedOxrSnapshot(): Promise<string> {
    const id = newUlid();
    await pool.query(
      `INSERT INTO fx_rate_snapshot
         (id, provider, base_currency, quote_currency, rate, observed_at)
       VALUES ($1, 'OXR', 'USD', 'GBP', 0.78000000, now())
       ON CONFLICT (provider, base_currency, quote_currency, observed_at) DO NOTHING`,
      [id],
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM fx_rate_snapshot
         WHERE provider='OXR' AND base_currency='USD' AND quote_currency='GBP'
        ORDER BY observed_at DESC LIMIT 1`,
    );
    return rows[0]!.id;
  }

  // ─── Repository read paths ────────────────────────────────────────────────

  it('loadById returns undefined for a non-existent booking', async () => {
    const missing = await repository.loadById(pool, newUlid());
    expect(missing).toBeUndefined();
  });

  it('loadById returns the booking with its current status and pricing', async () => {
    const id = await seedBooking({ status: 'INITIATED' });
    const record = await repository.loadById(pool, id);
    expect(record).toBeDefined();
    expect(record!.id).toBe(id);
    expect(record!.status).toBe('INITIATED');
    expect(record!.sellAmountMinorUnits).toBe(10000n);
    expect(record!.sellCurrency).toBe('USD');
  });

  // ─── Service: same-currency confirm (no FX row) ───────────────────────────

  it('confirms an INITIATED booking with no FX row when source equals charge currency', async () => {
    const id = await seedBooking({ status: 'INITIATED', sellCurrency: 'USD' });
    const result = await makeService().confirm({
      bookingId: id,
      chargeCurrency: 'USD',
    });
    expect(result.alreadyConfirmed).toBe(false);
    expect(result.fxOutcome).toEqual({ kind: 'NO_LOCK_NEEDED' });

    const after = await repository.loadById(pool, id);
    expect(after!.status).toBe('CONFIRMED');

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM booking_fx_lock WHERE booking_id = $1`,
      [id],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('confirms a PENDING_PAYMENT booking the same way', async () => {
    const id = await seedBooking({
      status: 'PENDING_PAYMENT',
      sellCurrency: 'USD',
    });
    const result = await makeService().confirm({
      bookingId: id,
      chargeCurrency: 'USD',
    });
    expect(result.alreadyConfirmed).toBe(false);
    const after = await repository.loadById(pool, id);
    expect(after!.status).toBe('CONFIRMED');
  });

  // ─── Service: idempotency / state guards ──────────────────────────────────

  it('a second confirm on the same booking returns alreadyConfirmed: true', async () => {
    const id = await seedBooking({ status: 'INITIATED', sellCurrency: 'USD' });
    const service = makeService();
    await service.confirm({ bookingId: id, chargeCurrency: 'USD' });
    const second = await service.confirm({
      bookingId: id,
      chargeCurrency: 'USD',
    });
    expect(second).toEqual({ bookingId: id, alreadyConfirmed: true });
  });

  it('refuses to confirm a CANCELLED booking', async () => {
    const id = await seedBooking({ status: 'CANCELLED' });
    await expect(
      makeService().confirm({ bookingId: id, chargeCurrency: 'USD' }),
    ).rejects.toThrow(/Cannot confirm.*CANCELLED/);
  });

  it('throws NotFoundException for a missing booking id', async () => {
    await expect(
      makeService().confirm({ bookingId: newUlid(), chargeCurrency: 'USD' }),
    ).rejects.toThrow(/Booking not found/);
  });

  // ─── Service: pricing-pinned policy (locked C5c.2) ────────────────────────

  it('refuses to confirm a booking with null sell_amount_minor_units', async () => {
    const id = await seedBooking({
      status: 'INITIATED',
      sellAmountMinorUnits: null,
    });
    await expect(
      makeService().confirm({ bookingId: id, chargeCurrency: 'EUR' }),
    ).rejects.toThrow(/pricing not pinned/);
    const after = await repository.loadById(pool, id);
    expect(after!.status).toBe('INITIATED'); // unchanged
  });

  it('refuses to confirm a booking with null sell_currency', async () => {
    const id = await seedBooking({
      status: 'INITIATED',
      sellCurrency: null,
    });
    await expect(
      makeService().confirm({ bookingId: id, chargeCurrency: 'EUR' }),
    ).rejects.toThrow(/pricing not pinned/);
  });

  // ─── Service: full transaction with SNAPSHOT_REFERENCE FX lock ────────────

  it('confirms with a SNAPSHOT_REFERENCE row inserted in the same transaction', async () => {
    const id = await seedBooking({ status: 'INITIATED', sellCurrency: 'USD' });
    const snapshotId = await seedOxrSnapshot();
    setResolverDecision({
      kind: 'SNAPSHOT_REFERENCE',
      provider: 'OXR',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      rate: '0.78000000',
      rateSnapshotId: snapshotId,
    });

    const result = await makeService().confirm({
      bookingId: id,
      chargeCurrency: 'GBP',
    });

    expect(result.alreadyConfirmed).toBe(false);
    expect(result.fxOutcome).toEqual({
      kind: 'SNAPSHOT_REFERENCE',
      provider: 'OXR',
    });

    const { rows } = await pool.query<{
      lock_kind: string;
      provider: string;
      applied_kind: string;
      rate_snapshot_id: string;
    }>(
      `SELECT lock_kind, provider, applied_kind, rate_snapshot_id
         FROM booking_fx_lock WHERE booking_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lock_kind: 'SNAPSHOT_REFERENCE',
      provider: 'OXR',
      applied_kind: 'CONFIRMATION',
      rate_snapshot_id: snapshotId,
    });
  });

  // ─── Service: NO_LOCK_AVAILABLE — booking confirms, no FX row ─────────────

  it('confirms with no FX row when resolver reports NO_LOCK_AVAILABLE', async () => {
    const id = await seedBooking({ status: 'INITIATED', sellCurrency: 'USD' });
    setResolverDecision({
      kind: 'NO_LOCK_AVAILABLE',
      reason: 'STRIPE_FAILED_AND_NO_OXR_SNAPSHOT',
    });

    const result = await makeService().confirm({
      bookingId: id,
      chargeCurrency: 'JPY',
    });

    expect(result.fxOutcome).toEqual({ kind: 'NO_LOCK_AVAILABLE' });
    const after = await repository.loadById(pool, id);
    expect(after!.status).toBe('CONFIRMED');
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM booking_fx_lock WHERE booking_id = $1`,
      [id],
    );
    expect(rows[0]!.count).toBe('0');
  });

  // ─── Service: roll back when FX insert violates a CHECK ──────────────────

  it('rolls back the booking status update when the FX-lock insert violates a CHECK', async () => {
    const id = await seedBooking({ status: 'INITIATED', sellCurrency: 'USD' });
    // Craft a SNAPSHOT_REFERENCE decision with an unset rate_snapshot_id so
    // the schema's coherence CHECK rejects the insert.
    setResolverDecision({
      kind: 'SNAPSHOT_REFERENCE',
      provider: 'OXR',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      rate: '0.78000000',
      rateSnapshotId: '', // empty string is falsy enough to surface as null on insert
    } as never);

    await expect(
      makeService().confirm({ bookingId: id, chargeCurrency: 'GBP' }),
    ).rejects.toBeDefined();

    const after = await repository.loadById(pool, id);
    expect(after!.status).toBe('INITIATED'); // rolled back
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM booking_fx_lock WHERE booking_id = $1`,
      [id],
    );
    expect(rows[0]!.count).toBe('0');
  });
});
