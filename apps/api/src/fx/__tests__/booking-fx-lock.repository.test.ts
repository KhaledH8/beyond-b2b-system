import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newUlid } from '../../common/ulid';
import {
  BookingFxLockRepository,
  type BookingFxLockInput,
} from '../booking-fx-lock.repository';

/**
 * Integration tests for `booking_fx_lock` writes. Skips cleanly when
 * DATABASE_URL is absent. Verifies:
 *   - happy-path inserts for both lock kinds
 *   - the partial unique index on CONFIRMATION rejects duplicates
 *   - the schema's coherence CHECK rejects shape violations
 *
 * Each test seeds its own `core_tenant` + `core_account` +
 * `hotel_canonical` + `booking_booking` row so reruns on a live DB
 * stay isolated. SNAPSHOT_REFERENCE tests also seed an `fx_rate_snapshot`
 * row to satisfy the FK.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('BookingFxLockRepository', () => {
  let pool: Pool;
  let repository: BookingFxLockRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    repository = new BookingFxLockRepository();
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedBooking(): Promise<string> {
    const tenantId = newUlid();
    const accountId = newUlid();
    const canonicalHotelId = newUlid();
    const bookingId = newUlid();
    const slug = `bfx-${bookingId.slice(-8).toLowerCase()}`;

    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `BookingFx Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'BookingFx Test Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1, 'BookingFx Test Hotel', 'AE')`,
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
         '2026-06-01', '2026-06-03', $5, 'INITIATED'
       )`,
      [bookingId, tenantId, accountId, canonicalHotelId, `BB-TEST-${slug}`],
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

  it('inserts a STRIPE_FX_QUOTE row for a booking', async () => {
    const bookingId = await seedBooking();
    const input: BookingFxLockInput = {
      id: newUlid(),
      bookingId,
      appliedKind: 'CONFIRMATION',
      lockKind: 'STRIPE_FX_QUOTE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      rate: '0.78003120',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      provider: 'STRIPE',
      providerQuoteId: 'fxq_test_1',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

    const { id } = await repository.insert(pool, input);
    expect(id).toBe(input.id);

    const { rows } = await pool.query<{
      lock_kind: string;
      provider: string;
      rate: string;
      provider_quote_id: string | null;
      rate_snapshot_id: string | null;
    }>(`SELECT lock_kind, provider, rate, provider_quote_id, rate_snapshot_id
          FROM booking_fx_lock WHERE id = $1`, [id]);
    expect(rows[0]!.lock_kind).toBe('STRIPE_FX_QUOTE');
    expect(rows[0]!.provider).toBe('STRIPE');
    expect(rows[0]!.provider_quote_id).toBe('fxq_test_1');
    expect(rows[0]!.rate_snapshot_id).toBeNull();
  });

  it('inserts a SNAPSHOT_REFERENCE row referencing an fx_rate_snapshot', async () => {
    const bookingId = await seedBooking();
    const snapshotId = await seedOxrSnapshot();
    const input: BookingFxLockInput = {
      id: newUlid(),
      bookingId,
      appliedKind: 'CONFIRMATION',
      lockKind: 'SNAPSHOT_REFERENCE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      rate: '0.78000000',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      provider: 'OXR',
      rateSnapshotId: snapshotId,
    };

    const { id } = await repository.insert(pool, input);
    const { rows } = await pool.query<{ rate_snapshot_id: string }>(
      `SELECT rate_snapshot_id FROM booking_fx_lock WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.rate_snapshot_id).toBe(snapshotId);
  });

  it('rejects a second CONFIRMATION row for the same booking via the partial unique index', async () => {
    const bookingId = await seedBooking();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await repository.insert(pool, {
      id: newUlid(),
      bookingId,
      appliedKind: 'CONFIRMATION',
      lockKind: 'STRIPE_FX_QUOTE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      rate: '0.78003120',
      sourceMinor: 10000n,
      chargeMinor: 7800n,
      provider: 'STRIPE',
      providerQuoteId: 'fxq_a',
      expiresAt,
    });

    await expect(
      repository.insert(pool, {
        id: newUlid(),
        bookingId,
        appliedKind: 'CONFIRMATION',
        lockKind: 'STRIPE_FX_QUOTE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78003120',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
        provider: 'STRIPE',
        providerQuoteId: 'fxq_b',
        expiresAt,
      }),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });

  it('allows multiple REFUND rows for the same booking', async () => {
    const bookingId = await seedBooking();
    const snapshotId = await seedOxrSnapshot();
    const make = (): BookingFxLockInput => ({
      id: newUlid(),
      bookingId,
      appliedKind: 'REFUND',
      lockKind: 'SNAPSHOT_REFERENCE',
      sourceCurrency: 'USD',
      chargeCurrency: 'GBP',
      rate: '0.78000000',
      sourceMinor: 5000n,
      chargeMinor: 3900n,
      provider: 'OXR',
      rateSnapshotId: snapshotId,
    });
    await repository.insert(pool, make());
    await expect(repository.insert(pool, make())).resolves.toBeDefined();
  });

  it('rejects a STRIPE_FX_QUOTE row missing expires_at via coherence CHECK', async () => {
    const bookingId = await seedBooking();
    await expect(
      repository.insert(pool, {
        id: newUlid(),
        bookingId,
        appliedKind: 'CONFIRMATION',
        lockKind: 'STRIPE_FX_QUOTE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78003120',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
        provider: 'STRIPE',
        providerQuoteId: 'fxq_no_expiry',
        // expiresAt intentionally omitted
      }),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('rejects a SNAPSHOT_REFERENCE row missing rate_snapshot_id via coherence CHECK', async () => {
    const bookingId = await seedBooking();
    await expect(
      repository.insert(pool, {
        id: newUlid(),
        bookingId,
        appliedKind: 'CONFIRMATION',
        lockKind: 'SNAPSHOT_REFERENCE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78000000',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
        provider: 'OXR',
        // rateSnapshotId intentionally omitted
      }),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  // ─── findConfirmation (C5d.1) ─────────────────────────────────────────────

  describe('findConfirmation', () => {
    it('returns undefined when no rows exist for the booking', async () => {
      const bookingId = await seedBooking();
      const found = await repository.findConfirmation(pool, bookingId);
      expect(found).toBeUndefined();
    });

    it('returns undefined when the booking has only a REFUND row (no CONFIRMATION)', async () => {
      const bookingId = await seedBooking();
      const snapshotId = await seedOxrSnapshot();
      await repository.insert(pool, {
        id: newUlid(),
        bookingId,
        appliedKind: 'REFUND',
        lockKind: 'SNAPSHOT_REFERENCE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78000000',
        sourceMinor: 5000n,
        chargeMinor: 3900n,
        provider: 'OXR',
        rateSnapshotId: snapshotId,
      });
      const found = await repository.findConfirmation(pool, bookingId);
      expect(found).toBeUndefined();
    });

    it('returns the STRIPE_FX_QUOTE confirmation row with all fields mapped', async () => {
      const bookingId = await seedBooking();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const insertedId = newUlid();
      await repository.insert(pool, {
        id: insertedId,
        bookingId,
        appliedKind: 'CONFIRMATION',
        lockKind: 'STRIPE_FX_QUOTE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78003120',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
        provider: 'STRIPE',
        providerQuoteId: 'fxq_test_findconf',
        expiresAt,
      });

      const found = await repository.findConfirmation(pool, bookingId);
      expect(found).toBeDefined();
      expect(found!.id).toBe(insertedId);
      expect(found!.bookingId).toBe(bookingId);
      expect(found!.appliedKind).toBe('CONFIRMATION');
      expect(found!.lockKind).toBe('STRIPE_FX_QUOTE');
      expect(found!.sourceCurrency).toBe('USD');
      expect(found!.chargeCurrency).toBe('GBP');
      expect(found!.rate).toBe('0.78003120');
      expect(found!.sourceMinor).toBe(10000n);
      expect(found!.chargeMinor).toBe(7800n);
      expect(found!.provider).toBe('STRIPE');
      expect(found!.providerQuoteId).toBe('fxq_test_findconf');
      expect(found!.rateSnapshotId).toBeNull();
      expect(found!.expiresAt).toBe(expiresAt);
      expect(found!.appliedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    it('returns the SNAPSHOT_REFERENCE confirmation row with rate_snapshot_id populated and expiresAt null', async () => {
      const bookingId = await seedBooking();
      const snapshotId = await seedOxrSnapshot();
      await repository.insert(pool, {
        id: newUlid(),
        bookingId,
        appliedKind: 'CONFIRMATION',
        lockKind: 'SNAPSHOT_REFERENCE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78000000',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
        provider: 'OXR',
        rateSnapshotId: snapshotId,
      });

      const found = await repository.findConfirmation(pool, bookingId);
      expect(found).toBeDefined();
      expect(found!.lockKind).toBe('SNAPSHOT_REFERENCE');
      expect(found!.provider).toBe('OXR');
      expect(found!.rateSnapshotId).toBe(snapshotId);
      expect(found!.providerQuoteId).toBeNull();
      expect(found!.expiresAt).toBeNull();
    });

    it('isolates lookups by booking_id', async () => {
      const bookingA = await seedBooking();
      const bookingB = await seedBooking();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await repository.insert(pool, {
        id: newUlid(),
        bookingId: bookingA,
        appliedKind: 'CONFIRMATION',
        lockKind: 'STRIPE_FX_QUOTE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78003120',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
        provider: 'STRIPE',
        providerQuoteId: 'fxq_iso_a',
        expiresAt,
      });

      const foundA = await repository.findConfirmation(pool, bookingA);
      const foundB = await repository.findConfirmation(pool, bookingB);
      expect(foundA?.bookingId).toBe(bookingA);
      expect(foundB).toBeUndefined();
    });

    it('returns the CONFIRMATION row when REFUND rows also exist (predicate scopes to applied_kind)', async () => {
      const bookingId = await seedBooking();
      const snapshotId = await seedOxrSnapshot();
      const confirmationId = newUlid();
      await repository.insert(pool, {
        id: confirmationId,
        bookingId,
        appliedKind: 'CONFIRMATION',
        lockKind: 'SNAPSHOT_REFERENCE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78000000',
        sourceMinor: 10000n,
        chargeMinor: 7800n,
        provider: 'OXR',
        rateSnapshotId: snapshotId,
      });
      await repository.insert(pool, {
        id: newUlid(),
        bookingId,
        appliedKind: 'REFUND',
        lockKind: 'SNAPSHOT_REFERENCE',
        sourceCurrency: 'USD',
        chargeCurrency: 'GBP',
        rate: '0.78000000',
        sourceMinor: 5000n,
        chargeMinor: 3900n,
        provider: 'OXR',
        rateSnapshotId: snapshotId,
      });

      const found = await repository.findConfirmation(pool, bookingId);
      expect(found).toBeDefined();
      expect(found!.id).toBe(confirmationId);
      expect(found!.appliedKind).toBe('CONFIRMATION');
    });
  });
});
