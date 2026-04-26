import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  CreateBucketCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AdapterSupplierRate } from '@bb/supplier-contract';
import {
  createProvisionalResolver,
  runHotelContentSync,
  runSourcedSearchAndPersist,
} from '@bb/adapter-hotelbeds';
import {
  HOTELBEDS_FIXTURES,
  createFixtureHotelbedsClient,
} from '@bb/testing';
import { newUlid } from '../../../common/ulid';
import { PgSupplierRegistrationPort } from '../supplier-registration.port';
import { PgHotelContentPersistencePort } from '../hotel-content.port';
import { PgMappingPersistencePort } from '../mapping-persistence.port';
import { PgSourcedOfferPersistencePort } from '../sourced-offer-persistence.port';
import { MinioRawPayloadStoragePort } from '../raw-payload-storage.port';
import {
  ProvisionalMoneyMovementError,
  assertRateBookable,
} from '../../../booking/booking-guard';

/**
 * Recorded-fixture conformance suite for the Hotelbeds adapter.
 *
 * Drives `runHotelContentSync` and `runSourcedSearchAndPersist` with
 * the `HotelbedsClient` fixture implementation from `@bb/testing`,
 * against the live local stack (Postgres + MinIO) the user has already
 * validated. No live HTTP; no booking; no pricing; no authored-rate
 * writes. The money-movement resolver remains `createProvisionalResolver`
 * and every rate surfaces `moneyMovementProvenance = 'PROVISIONAL'` —
 * the booking guard is expected to refuse the rate.
 *
 * The suite requires the local docker stack to be running
 * (`pnpm db:up`) and migrations to be applied (`pnpm db:migrate`).
 * When the env is absent, the suite skips cleanly so CI without a
 * local stack is not broken.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('hotelbeds adapter · fixture-replay conformance', () => {
  let pool: Pool;
  let s3: S3Client;
  let bucket: string;
  let tenantId: string;
  let registration: PgSupplierRegistrationPort;
  let hotels: PgHotelContentPersistencePort;
  let mappings: PgMappingPersistencePort;
  let offers: PgSourcedOfferPersistencePort;
  let rawStorage: MinioRawPayloadStoragePort;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });

    bucket = process.env['OBJECT_STORAGE_BUCKET'] ?? 'beyond-borders-local';
    s3 = new S3Client({
      region: process.env['OBJECT_STORAGE_REGION'] ?? 'us-east-1',
      endpoint:
        process.env['OBJECT_STORAGE_ENDPOINT'] ?? 'http://localhost:9000',
      forcePathStyle:
        (process.env['OBJECT_STORAGE_FORCE_PATH_STYLE'] ?? 'true')
          .toLowerCase() === 'true',
      credentials: {
        accessKeyId: process.env['OBJECT_STORAGE_ACCESS_KEY'] ?? 'bb_local',
        secretAccessKey:
          process.env['OBJECT_STORAGE_SECRET_KEY'] ?? 'bb_local_secret',
      },
    });

    // Idempotent bucket create. MinIO returns a typed error when the
    // bucket already exists; treat that as success so the test is
    // re-runnable on an already-initialised local stack.
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (err) {
      const code = (err as { name?: string }).name ?? '';
      if (
        code !== 'BucketAlreadyOwnedByYou' &&
        code !== 'BucketAlreadyExists'
      ) {
        throw err;
      }
    }

    // Fresh tenant per run: avoids cross-test state bleed and makes
    // the assertions trivially scope-able via tenant_id.
    tenantId = newUlid();
    const slug = `fixture-${randomBytes(6).toString('hex')}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Fixture Tenant ${slug}`],
    );

    registration = new PgSupplierRegistrationPort(pool);
    hotels = new PgHotelContentPersistencePort(pool);
    mappings = new PgMappingPersistencePort(pool);
    offers = new PgSourcedOfferPersistencePort(pool);
    rawStorage = new MinioRawPayloadStoragePort(s3, bucket);

    await registration.upsertSupplier({
      supplierId: 'hotelbeds',
      displayName: 'Hotelbeds',
      ingestionMode: 'PULL',
    });
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (s3) s3.destroy();
  });

  it('registers the hotelbeds supplier row in supply_supplier', async () => {
    const { rows } = await pool.query<{ code: string; source_type: string }>(
      `SELECT code, source_type FROM supply_supplier WHERE code = 'hotelbeds'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.source_type).toBe('AGGREGATOR');
  });

  it('persists fixture hotels via runHotelContentSync', async () => {
    const client = createFixtureHotelbedsClient(HOTELBEDS_FIXTURES);
    const result = await runHotelContentSync(
      { client, rawStorage, hotels },
      { ctx: { tenantId }, pageSize: 50, maxPages: 1 },
    );

    expect(result.pagesFetched).toBe(1);
    expect(result.hotelsUpserted).toBe(
      HOTELBEDS_FIXTURES.hotelsResponse.hotels.length,
    );

    const { rows } = await pool.query<{
      supplier_hotel_code: string;
      name: string;
    }>(
      `SELECT hs.supplier_hotel_code, hs.name
         FROM hotel_supplier hs
         JOIN supply_supplier s ON s.id = hs.supplier_id
         WHERE s.code = 'hotelbeds'
           AND hs.supplier_hotel_code = ANY($1::text[])
         ORDER BY hs.supplier_hotel_code`,
      [HOTELBEDS_FIXTURES.hotelsResponse.hotels.map((h) => h.code)],
    );
    expect(rows.length).toBe(
      HOTELBEDS_FIXTURES.hotelsResponse.hotels.length,
    );
    expect(rows[0]?.supplier_hotel_code).toBe('1000073');
  });

  it('persists sourced offers + mappings via runSourcedSearchAndPersist', async () => {
    const client = createFixtureHotelbedsClient(HOTELBEDS_FIXTURES);
    const searchSessionId = newUlid();

    const { rates, snapshotsWritten } = await runSourcedSearchAndPersist(
      {
        client,
        rawStorage,
        offers,
        mappings,
        moneyMovementResolver: createProvisionalResolver({
          fallbackTriple: {
            collectionMode: 'BB_COLLECTS',
            supplierSettlementMode: 'PREPAID_BALANCE',
            paymentCostModel: 'PLATFORM_CARD_FEE',
          },
          reason: 'conformance test — provisional safeguard remains engaged',
        }),
      },
      {
        ctx: { tenantId },
        searchSessionId,
        request: {
          supplierHotelId: '1000073',
          checkIn: '2026-06-01',
          checkOut: '2026-06-03',
          occupancy: { adults: 2, children: 0 },
          currency: 'EUR',
        },
        newSnapshotId: newUlid,
      },
    );

    // --- flat rate projection ---------------------------------------------
    const expectedRateCount =
      HOTELBEDS_FIXTURES.availabilityResponse.hotels[0]!.rooms[0]!.rates
        .length;
    expect(rates.length).toBe(expectedRateCount);
    expect(snapshotsWritten).toBe(expectedRateCount);

    for (const rate of rates) {
      expect(rate.supplierHotelId).toBe('1000073');
      expect(rate.moneyMovementProvenance).toBe('PROVISIONAL');
      expect(rate.offerShape).toBe('SOURCED_COMPOSED');
      expect(rate.rateBreakdownGranularity).toBe('TOTAL_ONLY');
    }

    // --- booking guard must refuse PROVISIONAL rates ----------------------
    const first = rates[0] as AdapterSupplierRate;
    expect(() => assertRateBookable(first)).toThrow(
      ProvisionalMoneyMovementError,
    );

    // --- offer_sourced_snapshot rows --------------------------------------
    const { rows: snapshotRows } = await pool.query<{
      total_currency: string;
      rate_breakdown_granularity: string;
      supplier_room_code: string;
      supplier_meal_code: string | null;
      raw_payload_hash: string;
      raw_payload_storage_ref: string;
    }>(
      `SELECT total_currency, rate_breakdown_granularity,
              supplier_room_code, supplier_meal_code,
              raw_payload_hash, raw_payload_storage_ref
         FROM offer_sourced_snapshot
         WHERE tenant_id = $1 AND search_session_id = $2
         ORDER BY supplier_rate_code`,
      [tenantId, searchSessionId],
    );
    expect(snapshotRows.length).toBe(expectedRateCount);
    for (const row of snapshotRows) {
      expect(row.total_currency).toBe('EUR');
      expect(row.rate_breakdown_granularity).toBe('TOTAL_ONLY');
      expect(row.supplier_room_code).toBe('DBL.ST');
      expect(row.raw_payload_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.raw_payload_storage_ref.startsWith('hotelbeds/availability/'))
        .toBe(true);
    }

    // --- cancellation policy (one rate has one; the other does not) ------
    const { rows: cancelRows } = await pool.query<{ refundable: boolean }>(
      `SELECT cp.refundable
         FROM offer_sourced_cancellation_policy cp
         JOIN offer_sourced_snapshot s ON s.id = cp.offer_snapshot_id
         WHERE s.tenant_id = $1 AND s.search_session_id = $2`,
      [tenantId, searchSessionId],
    );
    // One fixture rate has cancellationPolicies, the other does not.
    expect(cancelRows.length).toBe(1);

    // --- mapping observation rows (all four tables) -----------------------
    const roomRows = await pool.query(
      `SELECT 1 FROM hotel_room_mapping m
         JOIN supply_supplier s ON s.id = m.supplier_id
         JOIN hotel_supplier hs ON hs.id = m.supplier_hotel_id
         WHERE s.code = 'hotelbeds'
           AND hs.supplier_hotel_code = '1000073'
           AND m.supplier_room_code = 'DBL.ST'`,
    );
    expect(roomRows.rowCount).toBeGreaterThan(0);

    const rateRows = await pool.query(
      `SELECT supplier_rate_code FROM hotel_rate_plan_mapping m
         JOIN supply_supplier s ON s.id = m.supplier_id
         JOIN hotel_supplier hs ON hs.id = m.supplier_hotel_id
         WHERE s.code = 'hotelbeds'
           AND hs.supplier_hotel_code = '1000073'
         ORDER BY supplier_rate_code`,
    );
    const rateCodes = rateRows.rows.map(
      (r: { supplier_rate_code: string }) => r.supplier_rate_code,
    );
    expect(rateCodes).toEqual(expect.arrayContaining(['FLEX', 'NRF']));

    const mealRows = await pool.query(
      `SELECT supplier_meal_code FROM hotel_meal_plan_mapping m
         JOIN supply_supplier s ON s.id = m.supplier_id
         WHERE s.code = 'hotelbeds'
         ORDER BY supplier_meal_code`,
    );
    const mealCodes = mealRows.rows.map(
      (r: { supplier_meal_code: string }) => r.supplier_meal_code,
    );
    expect(mealCodes).toEqual(expect.arrayContaining(['BB', 'RO']));

    const occupancyRows = await pool.query(
      `SELECT 1 FROM hotel_occupancy_mapping m
         JOIN supply_supplier s ON s.id = m.supplier_id
         JOIN hotel_supplier hs ON hs.id = m.supplier_hotel_id
         WHERE s.code = 'hotelbeds'
           AND hs.supplier_hotel_code = '1000073'`,
    );
    expect(occupancyRows.rowCount).toBeGreaterThan(0);

    // --- raw payload landed in MinIO --------------------------------------
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: snapshotRows[0]!.raw_payload_storage_ref,
      }),
    );
    expect(obj.Body).toBeDefined();
  });

  it('does not touch any authored-rate tables (ADR-021 invariant)', async () => {
    // Phase A Slice 1 created the rate_auth_* tables; Phase A Slice 2 added
    // the DirectContracts module which writes to these tables for its own
    // tenants. The Hotelbeds sourced path must write ZERO rows scoped to
    // the Hotelbeds test tenant. Other tenants' rows are irrelevant.
    const checks: Array<{ label: string; sql: string; params: unknown[] }> = [
      {
        label: 'rate_auth_contract',
        sql: `SELECT COUNT(*) AS count FROM rate_auth_contract WHERE tenant_id = $1`,
        params: [tenantId],
      },
      {
        label: 'rate_auth_season',
        sql: `SELECT COUNT(*) AS count FROM rate_auth_season
              WHERE contract_id IN (SELECT id FROM rate_auth_contract WHERE tenant_id = $1)`,
        params: [tenantId],
      },
      {
        label: 'rate_auth_child_age_band',
        sql: `SELECT COUNT(*) AS count FROM rate_auth_child_age_band
              WHERE contract_id IN (SELECT id FROM rate_auth_contract WHERE tenant_id = $1)`,
        params: [tenantId],
      },
      {
        label: 'rate_auth_base_rate',
        sql: `SELECT COUNT(*) AS count FROM rate_auth_base_rate
              WHERE contract_id IN (SELECT id FROM rate_auth_contract WHERE tenant_id = $1)`,
        params: [tenantId],
      },
      {
        label: 'rate_auth_occupancy_supplement',
        sql: `SELECT COUNT(*) AS count FROM rate_auth_occupancy_supplement
              WHERE contract_id IN (SELECT id FROM rate_auth_contract WHERE tenant_id = $1)`,
        params: [tenantId],
      },
      {
        label: 'rate_auth_meal_supplement',
        sql: `SELECT COUNT(*) AS count FROM rate_auth_meal_supplement
              WHERE contract_id IN (SELECT id FROM rate_auth_contract WHERE tenant_id = $1)`,
        params: [tenantId],
      },
    ];

    for (const { label, sql, params } of checks) {
      const { rows } = await pool.query<{ count: string }>(sql, params);
      expect(
        Number(rows[0]!.count),
        `${label} must have 0 rows for the Hotelbeds tenant after the sourced flow`,
      ).toBe(0);
    }
  });
});
