import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newUlid } from '../../common/ulid';
import {
  BookingRepository,
  isUniqueViolation,
  type InsertInitiatedBookingInput,
} from '../booking.repository';

/**
 * Integration tests for the intake additions on BookingRepository
 * against a real Postgres. Skipped cleanly when DATABASE_URL is absent.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('BookingRepository — intake (real DB)', () => {
  let pool: Pool;
  let repo: BookingRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    repo = new BookingRepository();
  });

  afterAll(async () => {
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
    const slug = `bkir-${tenantId.slice(-8).toLowerCase()}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Repo Intake Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'Repo Intake Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1, 'Repo Intake Hotel', 'AE')`,
      [hotelId],
    );
    return { tenantId, accountId, hotelId };
  }

  function input(
    scope: { tenantId: string; accountId: string; hotelId: string },
    overrides: Partial<InsertInitiatedBookingInput> = {},
  ): InsertInitiatedBookingInput {
    return {
      id: newUlid(),
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      canonicalHotelId: scope.hotelId,
      reference: `BB-2026-${Math.floor(Math.random() * 100000)
        .toString()
        .padStart(5, '0')}`,
      checkIn: '2026-08-01',
      checkOut: '2026-08-05',
      guestDetails: { guest: { firstName: 'Grace' }, occupancy: { adults: 1 } },
      moneyMovement: {
        collectionMode: 'BB_COLLECTS',
        supplierSettlementMode: 'PREPAID_BALANCE',
        paymentCostModel: 'PLATFORM_CARD_FEE',
      },
      sellAmountMinorUnits: 19900n,
      sellCurrency: 'USD',
      sourceOfferSnapshotId: newUlid(),
      idempotencyKey: `idem-${newUlid()}`,
      supplierRef: 'HOTELBEDS',
      supplierRawRef: 'raw-xyz',
      ...overrides,
    };
  }

  it('insertInitiated creates an INITIATED row with intake fields persisted', async () => {
    const scope = await seedScope();
    const i = input(scope);
    const rec = await repo.insertInitiated(pool, i);

    expect(rec.status).toBe('INITIATED');
    expect(rec.id).toBe(i.id);
    expect(rec.reference).toBe(i.reference);
    expect(rec.sourceOfferSnapshotId).toBe(i.sourceOfferSnapshotId);
    expect(rec.supplierRef).toBe('HOTELBEDS');
    expect(rec.supplierRawRef).toBe('raw-xyz');
    expect(rec.sellAmountMinorUnits).toBe(19900n);
    expect(rec.sellCurrency).toBe('USD');
    expect(rec.checkIn).toBe('2026-08-01');
    expect(rec.checkOut).toBe('2026-08-05');
    expect(typeof rec.createdAt).toBe('string');

    const { rows } = await pool.query<{ supplier_id: string | null }>(
      `SELECT supplier_id FROM booking_booking WHERE id = $1`,
      [i.id],
    );
    expect(rows[0]!.supplier_id).toBeNull(); // FK reserved for later slice
  });

  it('findByIdempotencyKey returns the row for the same tenant+key', async () => {
    const scope = await seedScope();
    const i = input(scope);
    await repo.insertInitiated(pool, i);

    const found = await repo.findByIdempotencyKey(
      pool,
      scope.tenantId,
      i.idempotencyKey,
    );
    expect(found?.id).toBe(i.id);

    const missing = await repo.findByIdempotencyKey(
      pool,
      scope.tenantId,
      'no-such-key',
    );
    expect(missing).toBeUndefined();
  });

  it('is tenant-scoped: same key under another tenant does not match', async () => {
    const a = await seedScope();
    const b = await seedScope();
    const i = input(a, { idempotencyKey: 'shared-key' });
    await repo.insertInitiated(pool, i);

    const underB = await repo.findByIdempotencyKey(
      pool,
      b.tenantId,
      'shared-key',
    );
    expect(underB).toBeUndefined();
  });

  it('a duplicate idempotency key in the same tenant raises a unique violation', async () => {
    const scope = await seedScope();
    const first = input(scope, { idempotencyKey: 'dup-key' });
    await repo.insertInitiated(pool, first);
    const second = input(scope, { idempotencyKey: 'dup-key' });

    let caught: unknown;
    try {
      await repo.insertInitiated(pool, second);
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught, 'booking_booking_idem_uq')).toBe(true);
  });

  it('a duplicate reference in the same tenant raises a unique violation', async () => {
    const scope = await seedScope();
    const first = input(scope);
    await repo.insertInitiated(pool, first);
    const second = input(scope, { reference: first.reference });

    let caught: unknown;
    try {
      await repo.insertInitiated(pool, second);
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught, 'booking_booking_ref_uq')).toBe(true);
  });
});
