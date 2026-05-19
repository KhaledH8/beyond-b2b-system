import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newUlid } from '../../common/ulid';
import { BookingSnapshotRepository } from '../booking-snapshot.repository';

/**
 * Integration tests for BookingSnapshotRepository against a real
 * Postgres. Skipped cleanly when DATABASE_URL is absent.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('BookingSnapshotRepository (real DB)', () => {
  let pool: Pool;
  let repo: BookingSnapshotRepository;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    repo = new BookingSnapshotRepository();
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seed(opts: { withPolicy?: boolean } = {}): Promise<{
    tenantId: string;
    bookingId: string;
    sourceOfferSnapshotId: string;
  }> {
    const tenantId = newUlid();
    const accountId = newUlid();
    const hotelId = newUlid();
    const supplierId = newUlid();
    const bookingId = newUlid();
    const sourceOfferSnapshotId = newUlid();
    const slug = `sn-${bookingId.slice(-8).toLowerCase()}`;

    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1,$2,$3)`,
      [tenantId, slug, `Snap Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1,$2,'AGENCY','Snap Agency')`,
      [accountId, tenantId],
    );
    await pool.query(
      `INSERT INTO hotel_canonical (id, name, address_country)
         VALUES ($1,'Snap Hotel','AE')`,
      [hotelId],
    );
    await pool.query(
      `INSERT INTO supply_supplier (id, code, display_name, source_type)
         VALUES ($1,$2,'Snap Supplier','AGGREGATOR')`,
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
         '2026-06-01','2026-06-03',2,'DBL','BAR',
         10000,'USD','TOTAL_ONLY', now() + interval '1 hour',
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
       ) VALUES
         ($1,$2,'ROOM_RATE','Room',9000,'USD',FALSE),
         ($3,$2,'TAX','Tax',1000,'USD',FALSE)`,
      [newUlid(), sourceOfferSnapshotId, newUlid()],
    );
    if (opts.withPolicy) {
      await pool.query(
        `INSERT INTO offer_sourced_cancellation_policy (
           id, offer_snapshot_id, windows_jsonb, refundable
         ) VALUES ($1,$2,'[]'::jsonb,TRUE)`,
        [newUlid(), sourceOfferSnapshotId],
      );
    }
    await pool.query(
      `INSERT INTO booking_booking (
         id, tenant_id, account_id, canonical_hotel_id,
         collection_mode, supplier_settlement_mode, payment_cost_model,
         check_in, check_out, reference, status,
         sell_amount_minor_units, sell_currency, source_offer_snapshot_id
       ) VALUES (
         $1,$2,$3,$4,'BB_COLLECTS','PREPAID_BALANCE','PLATFORM_CARD_FEE',
         '2026-06-01','2026-06-03',$5,'INITIATED',10000,'USD',$6
       )`,
      [bookingId, tenantId, accountId, hotelId, `BB-SN-${slug}`, sourceOfferSnapshotId],
    );
    return { tenantId, bookingId, sourceOfferSnapshotId };
  }

  it('loads the source offer snapshot tenant-scoped', async () => {
    const s = await seed();
    const row = await repo.loadSourceOfferSnapshot(
      pool,
      s.tenantId,
      s.sourceOfferSnapshotId,
    );
    expect(row?.id).toBe(s.sourceOfferSnapshotId);
    expect(row?.total_amount_minor_units).toBe('10000');
    expect(row?.check_in).toBe('2026-06-01');

    const wrongTenant = await repo.loadSourceOfferSnapshot(
      pool,
      newUlid(),
      s.sourceOfferSnapshotId,
    );
    expect(wrongTenant).toBeUndefined();
  });

  it('pins offer + components + tax/fee + policy as immutable rows', async () => {
    const s = await seed({ withPolicy: true });
    const src = await repo.loadSourceOfferSnapshot(
      pool,
      s.tenantId,
      s.sourceOfferSnapshotId,
    );
    const bookingOfferSnapshotId =
      await repo.insertBookingSourcedOfferSnapshot(pool, {
        bookingId: s.bookingId,
        tenantId: s.tenantId,
        sourceOfferSnapshotId: s.sourceOfferSnapshotId,
        source: src!,
      });
    const components = await repo.loadSourceComponents(
      pool,
      s.sourceOfferSnapshotId,
    );
    expect(components).toHaveLength(2);
    const nComp = await repo.insertBookingPriceComponentSnapshots(pool, {
      bookingId: s.bookingId,
      bookingOfferSnapshotId,
      components,
    });
    expect(nComp).toBe(2);
    const nTax = await repo.insertBookingTaxFeeSnapshots(pool, {
      bookingId: s.bookingId,
      bookingOfferSnapshotId,
      components,
    });
    expect(nTax).toBe(1); // only the TAX component

    const policy = await repo.loadSourceCancellationPolicy(
      pool,
      s.sourceOfferSnapshotId,
    );
    expect(policy?.refundable).toBe(true);
    await repo.insertBookingCancellationPolicySnapshot(pool, {
      bookingId: s.bookingId,
      bookingOfferSnapshotId,
      source: policy!,
    });

    expect(await repo.snapshotExistsForBooking(pool, s.bookingId)).toBe(
      true,
    );

    const offer = await pool.query(
      `SELECT total_amount_minor_units, source_offer_snapshot_id
         FROM booking_sourced_offer_snapshot WHERE booking_id = $1`,
      [s.bookingId],
    );
    expect(offer.rows[0].total_amount_minor_units).toBe('10000');
    expect(offer.rows[0].source_offer_snapshot_id).toBe(
      s.sourceOfferSnapshotId,
    );
  });

  it('rejects a second offer snapshot for the same booking (1:1)', async () => {
    const s = await seed();
    const src = await repo.loadSourceOfferSnapshot(
      pool,
      s.tenantId,
      s.sourceOfferSnapshotId,
    );
    await repo.insertBookingSourcedOfferSnapshot(pool, {
      bookingId: s.bookingId,
      tenantId: s.tenantId,
      sourceOfferSnapshotId: s.sourceOfferSnapshotId,
      source: src!,
    });
    await expect(
      repo.insertBookingSourcedOfferSnapshot(pool, {
        bookingId: s.bookingId,
        tenantId: s.tenantId,
        sourceOfferSnapshotId: s.sourceOfferSnapshotId,
        source: src!,
      }),
    ).rejects.toThrow();
  });

  it('booking-time snapshot rows are immutable (UPDATE/DELETE blocked)', async () => {
    const s = await seed();
    const src = await repo.loadSourceOfferSnapshot(
      pool,
      s.tenantId,
      s.sourceOfferSnapshotId,
    );
    await repo.insertBookingSourcedOfferSnapshot(pool, {
      bookingId: s.bookingId,
      tenantId: s.tenantId,
      sourceOfferSnapshotId: s.sourceOfferSnapshotId,
      source: src!,
    });
    await expect(
      pool.query(
        `UPDATE booking_sourced_offer_snapshot
            SET total_amount_minor_units = 1 WHERE booking_id = $1`,
        [s.bookingId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(
        `DELETE FROM booking_sourced_offer_snapshot WHERE booking_id = $1`,
        [s.bookingId],
      ),
    ).rejects.toThrow(/immutable/);
  });
});
