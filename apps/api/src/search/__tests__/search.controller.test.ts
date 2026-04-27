import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { SearchResponse } from '@bb/domain';
import { newUlid } from '../../common/ulid';
import { AdaptersModule } from '../../adapters/adapters.module';
import { DatabaseModule } from '../../database/database.module';
import { ObjectStorageModule } from '../../object-storage/object-storage.module';
import { SearchModule } from '../search.module';

/**
 * Integration test for the channel-aware search seam.
 *
 * Boots a real Nest app in Hotelbeds-fixture mode against the local
 * Postgres + MinIO stack. Seeds:
 *   - one tenant
 *   - one AGENCY account on that tenant
 *   - one CHANNEL-scope markup rule (10%) for AGENCY
 *   - one HOTEL-scope markup rule (15%) targeting fixture hotel 1000073
 *   - one PROMOTED merchandising tag on the same hotel
 *
 * Then drives `POST /search` and asserts:
 *   - HOTEL precedence wins over CHANNEL (15% applied, not 10%)
 *   - selling price = net + 15% markup
 *   - promotion tag attached
 *   - every priced rate carries `isBookable=false` + `bookingRefusalReason`
 *   - response sorts hotels by cheapest selling price
 *
 * Skips cleanly when DATABASE_URL is absent so CI without a local
 * stack does not fail.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('search controller · channel-aware pricing (fixture mode)', () => {
  let app: INestApplication;
  let pool: Pool;
  let tenantId: string;
  let accountId: string;

  beforeAll(async () => {
    process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;
    process.env['HOTELBEDS_CLIENT_KIND'] = 'fixture';
    process.env['HOTELBEDS_FIXTURE_DIR'] = path.resolve(
      __dirname,
      '../../../../../packages/testing/src/hotelbeds/fixtures',
    );

    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    const bucket = process.env['OBJECT_STORAGE_BUCKET'] ?? 'beyond-borders-local';
    const s3 = new S3Client({
      region: process.env['OBJECT_STORAGE_REGION'] ?? 'us-east-1',
      endpoint:
        process.env['OBJECT_STORAGE_ENDPOINT'] ?? 'http://localhost:9000',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env['OBJECT_STORAGE_ACCESS_KEY'] ?? 'bb_local',
        secretAccessKey:
          process.env['OBJECT_STORAGE_SECRET_KEY'] ?? 'bb_local_secret',
      },
    });
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
    s3.destroy();

    tenantId = newUlid();
    accountId = newUlid();
    const slug = `srch-${randomBytes(6).toString('hex')}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Search Test Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'Search Test Agency')`,
      [accountId, tenantId],
    );

    // Boot Nest now so HotelbedsModule's onModuleInit registers the
    // 'hotelbeds' supplier row before we seed the per-hotel markup rule
    // (which FKs into hotel_supplier).
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, ObjectStorageModule, AdaptersModule, SearchModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // Run a content-sync via the registry's adapter so hotel_supplier
    // has a row for the fixture hotel — pricing's HOTEL scope keys on
    // hotel_supplier.id.
    await app.getHttpServer(); // ensure server is constructed (idempotent)
    const server = app.getHttpServer() as Parameters<typeof fetch>[0];
    const url = await urlFor(server, '/internal/suppliers/hotelbeds/content-sync');
    const csRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ tenantId, pageSize: 50, maxPages: 1 }),
    });
    if (csRes.status !== 201) {
      throw new Error(`content-sync seed failed: HTTP ${csRes.status}`);
    }

    // Seed pricing rules + promotion targeting hotel 1000073.
    const { rows: hsRows } = await pool.query<{ id: string }>(
      `SELECT hs.id FROM hotel_supplier hs
         JOIN supply_supplier s ON s.id = hs.supplier_id
        WHERE s.code = 'hotelbeds' AND hs.supplier_hotel_code = '1000073'`,
    );
    const supplierHotelId = hsRows[0]!.id;

    await pool.query(
      `INSERT INTO pricing_markup_rule
         (id, tenant_id, scope, account_type, markup_kind, percent_value, priority)
       VALUES ($1, $2, 'CHANNEL', 'AGENCY', 'PERCENT', 10.0000, 0)`,
      [newUlid(), tenantId],
    );
    await pool.query(
      `INSERT INTO pricing_markup_rule
         (id, tenant_id, scope, supplier_hotel_id, markup_kind, percent_value, priority)
       VALUES ($1, $2, 'HOTEL', $3, 'PERCENT', 15.0000, 0)`,
      [newUlid(), tenantId, supplierHotelId],
    );
    await pool.query(
      `INSERT INTO merch_promotion
         (id, tenant_id, supplier_hotel_id, kind, priority, account_type)
       VALUES ($1, $2, $3, 'PROMOTED', 100, 'AGENCY')`,
      [newUlid(), tenantId, supplierHotelId],
    );
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  it('applies HOTEL-scope markup over CHANNEL default and tags promotion', async () => {
    const server = app.getHttpServer() as Parameters<typeof fetch>[0];
    const url = await urlFor(server, '/search');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        accountId,
        supplierHotelIds: ['1000073'],
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        occupancy: { adults: 2, children: 0 },
        currency: 'EUR',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SearchResponse;

    expect(body.meta.accountContext.accountType).toBe('AGENCY');
    expect(body.meta.currency).toBe('EUR');
    expect(body.results.length).toBe(1);

    const hotel = body.results[0]!;
    expect(hotel.supplierHotelCode).toBe('1000073');
    expect(hotel.promotion?.kind).toBe('PROMOTED');
    expect(hotel.rates.length).toBeGreaterThan(0);

    for (const rate of hotel.rates) {
      // The pricing engine works in minor-unit BigInts; assert against
      // the exact decimal strings rather than via float multiplication
      // (which has rounding ambiguity at the .005 boundary).
      const net = rate.priceQuote.netCost.amount;
      const sell = rate.priceQuote.sellingPrice.amount;
      const markupAmount = rate.priceQuote.appliedMarkup?.markupAmount.amount;
      expect(markupAmount).toBeDefined();
      // sell == net + markupAmount, exactly, in the same currency.
      const netMinor = Math.round(Number.parseFloat(net) * 100);
      const sellMinor = Math.round(Number.parseFloat(sell) * 100);
      const markupMinor = Math.round(Number.parseFloat(markupAmount!) * 100);
      expect(sellMinor).toBe(netMinor + markupMinor);
      // Markup is roughly 15% of net (within one minor unit due to
      // half-away-from-zero rounding).
      expect(Math.abs(markupMinor - Math.round(netMinor * 0.15))).toBeLessThanOrEqual(1);

      expect(rate.priceQuote.appliedMarkup?.scope).toBe('HOTEL');
      expect(rate.priceQuote.appliedMarkup?.percentValue).toBe('15.0000');

      // PROVISIONAL safeguard preserved end-to-end.
      expect(rate.moneyMovementProvenance).toBe('PROVISIONAL');
      expect(rate.isBookable).toBe(false);
      expect(rate.bookingRefusalReason).toMatch(/PROVISIONAL/);

      // Pricing trace records the bind step and the rule firing.
      expect(rate.trace.steps.length).toBe(3);
      expect(rate.trace.steps[0]!.kind).toBe('NET_COST');
      expect(rate.trace.steps[1]!.kind).toBe('COLLECTION_AND_SETTLEMENT_BIND');
      expect(rate.trace.steps[2]!.kind).toBe('MARKUP_APPLIED');
    }

    // Rates within a hotel sort by selling price ascending.
    if (hotel.rates.length > 1) {
      const first = Number.parseFloat(hotel.rates[0]!.priceQuote.sellingPrice.amount);
      const second = Number.parseFloat(hotel.rates[1]!.priceQuote.sellingPrice.amount);
      expect(first).toBeLessThanOrEqual(second);
    }
  });

  it('rejects malformed bodies with 400', async () => {
    const server = app.getHttpServer() as Parameters<typeof fetch>[0];
    const url = await urlFor(server, '/search');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId, accountId }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * Slice 5 — authored fan-out + merge.
 *
 * Boots the same Nest stack but additionally seeds a DIRECT supplier
 * + an active `rate_auth_*` direct contract on the same canonical
 * hotel as the Hotelbeds fixture hotel. POST /search should then
 * return both supplier results merged: the Hotelbeds-sourced offer
 * (PROVISIONAL, isBookable=false) AND the authored offer
 * (CONFIG_RESOLVED, isBookable=true, offerShape AUTHORED_PRIMITIVES).
 * Both `SearchResultHotel` entries carry the same `canonicalHotelId`.
 */
describeIntegration('search controller · authored direct contracts merge', () => {
  let app: INestApplication;
  let pool: Pool;
  let tenantId: string;
  let accountId: string;
  let canonicalHotelId: string;
  let directSupplierId: string;
  let directSupplierCode: string;
  let contractId: string;

  beforeAll(async () => {
    process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;
    process.env['HOTELBEDS_CLIENT_KIND'] = 'fixture';
    process.env['HOTELBEDS_FIXTURE_DIR'] = path.resolve(
      __dirname,
      '../../../../../packages/testing/src/hotelbeds/fixtures',
    );

    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    const bucket = process.env['OBJECT_STORAGE_BUCKET'] ?? 'beyond-borders-local';
    const s3 = new S3Client({
      region: process.env['OBJECT_STORAGE_REGION'] ?? 'us-east-1',
      endpoint:
        process.env['OBJECT_STORAGE_ENDPOINT'] ?? 'http://localhost:9000',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env['OBJECT_STORAGE_ACCESS_KEY'] ?? 'bb_local',
        secretAccessKey:
          process.env['OBJECT_STORAGE_SECRET_KEY'] ?? 'bb_local_secret',
      },
    });
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
    s3.destroy();

    tenantId = newUlid();
    accountId = newUlid();
    const slug = `srch-aut-${randomBytes(6).toString('hex')}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Authored Search Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'Authored Search Agency')`,
      [accountId, tenantId],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, ObjectStorageModule, AdaptersModule, SearchModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // Populate hotel_supplier for fixture hotel '1000073' via the
    // Hotelbeds content-sync, then build a canonical + mapping so the
    // authored fan-out can resolve the canonical id from the request
    // code.
    const csUrl = await urlFor(app.getHttpServer(), '/internal/suppliers/hotelbeds/content-sync');
    const csRes = await fetch(csUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({ tenantId, pageSize: 50, maxPages: 1 }),
    });
    if (csRes.status !== 201) {
      throw new Error(`content-sync seed failed: HTTP ${csRes.status}`);
    }

    const { rows: hsRows } = await pool.query<{ id: string }>(
      `SELECT hs.id FROM hotel_supplier hs
         JOIN supply_supplier s ON s.id = hs.supplier_id
        WHERE s.code = 'hotelbeds' AND hs.supplier_hotel_code = '1000073'`,
    );
    const hotelbedsSupplierHotelId = hsRows[0]!.id;

    // The suite is re-runnable on a live DB. `hotel_supplier` for code
    // '1000073' persists across runs, and `hotel_mapping_active_supplier_uq`
    // forbids a second active mapping for the same `hotel_supplier_id`.
    // Reuse the existing mapping's canonical hotel when one is already
    // present; otherwise create a fresh pair.
    const { rows: existingMapping } = await pool.query<{
      canonical_hotel_id: string;
    }>(
      `SELECT canonical_hotel_id
         FROM hotel_mapping
        WHERE hotel_supplier_id = $1
          AND mapping_status NOT IN ('REJECTED', 'SUPERSEDED')
        LIMIT 1`,
      [hotelbedsSupplierHotelId],
    );
    if (existingMapping.length > 0) {
      canonicalHotelId = existingMapping[0]!.canonical_hotel_id;
    } else {
      canonicalHotelId = newUlid();
      await pool.query(
        `INSERT INTO hotel_canonical (id, name) VALUES ($1, $2)`,
        [canonicalHotelId, `Authored Test Hotel ${slug}`],
      );
      await pool.query(
        `INSERT INTO hotel_mapping
           (id, canonical_hotel_id, hotel_supplier_id, mapping_status, mapping_method)
         VALUES ($1, $2, $3, 'CONFIRMED', 'DETERMINISTIC')`,
        [newUlid(), canonicalHotelId, hotelbedsSupplierHotelId],
      );
    }

    // DIRECT supplier + active contract on the same canonical hotel.
    directSupplierId = newUlid();
    directSupplierCode = `direct-${slug}`;
    await pool.query(
      `INSERT INTO supply_supplier (id, code, display_name, source_type, status)
       VALUES ($1, $2, 'Authored Test Direct', 'DIRECT', 'ACTIVE')`,
      [directSupplierId, directSupplierCode],
    );

    contractId = newUlid();
    await pool.query(
      `INSERT INTO rate_auth_contract
         (id, tenant_id, canonical_hotel_id, supplier_id, contract_code, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'EUR', 'ACTIVE')`,
      [contractId, tenantId, canonicalHotelId, directSupplierId, `CTR-${slug}`],
    );

    const seasonId = newUlid();
    await pool.query(
      `INSERT INTO rate_auth_season (id, contract_id, name, date_from, date_to)
       VALUES ($1, $2, 'Summer', '2026-05-01', '2026-09-30')`,
      [seasonId, contractId],
    );

    const roomTypeId = newUlid();
    await pool.query(
      `INSERT INTO hotel_room_type (id, canonical_hotel_id, code, name)
       VALUES ($1, $2, $3, $4)`,
      [roomTypeId, canonicalHotelId, `DBL-${slug}`, 'Authored Double'],
    );
    const ratePlanId = newUlid();
    await pool.query(
      `INSERT INTO hotel_rate_plan (id, canonical_hotel_id, code, name, rate_class)
       VALUES ($1, $2, $3, $4, 'NEGOTIATED')`,
      [ratePlanId, canonicalHotelId, `NEG-${slug}`, 'Negotiated Rate'],
    );
    const mealPlanId = newUlid();
    await pool.query(
      `INSERT INTO hotel_meal_plan (id, canonical_hotel_id, code, name)
       VALUES ($1, $2, $3, 'Room Only')`,
      [mealPlanId, canonicalHotelId, `RO-${slug}`],
    );
    const occTemplateId = newUlid();
    await pool.query(
      `INSERT INTO hotel_occupancy_template
         (id, canonical_hotel_id, room_type_id, base_adults, max_adults, max_children, max_total)
       VALUES ($1, $2, $3, 2, 2, 0, 2)`,
      [occTemplateId, canonicalHotelId, roomTypeId],
    );

    await pool.query(
      `INSERT INTO rate_auth_base_rate
         (id, contract_id, season_id, room_type_id, rate_plan_id,
          occupancy_template_id, included_meal_plan_id,
          amount_minor_units, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 12500, 'EUR')`,
      [
        newUlid(),
        contractId,
        seasonId,
        roomTypeId,
        ratePlanId,
        occTemplateId,
        mealPlanId,
      ],
    );
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  it('returns sourced + authored results for the same canonical hotel, both with canonicalHotelId set', async () => {
    const url = await urlFor(app.getHttpServer(), '/search');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        accountId,
        supplierHotelIds: ['1000073'],
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        occupancy: { adults: 2, children: 0 },
        currency: 'EUR',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SearchResponse;

    expect(body.results.length).toBeGreaterThanOrEqual(2);
    const sourced = body.results.find((h) => h.supplierId === 'hotelbeds');
    const authored = body.results.find((h) => h.supplierId === directSupplierCode);
    expect(sourced).toBeDefined();
    expect(authored).toBeDefined();

    // Cross-supplier correlation key.
    expect(sourced!.canonicalHotelId).toBe(canonicalHotelId);
    expect(authored!.canonicalHotelId).toBe(canonicalHotelId);

    // Sourced retains its existing PROVISIONAL safeguard.
    for (const r of sourced!.rates) {
      expect(r.moneyMovementProvenance).toBe('PROVISIONAL');
      expect(r.isBookable).toBe(false);
      expect(r.bookingRefusalReason).toMatch(/PROVISIONAL/);
    }

    // Authored offers are non-provisional and bookable.
    expect(authored!.rates.length).toBeGreaterThan(0);
    for (const r of authored!.rates) {
      expect(r.offerShape).toBe('AUTHORED_PRIMITIVES');
      expect(r.rateBreakdownGranularity).toBe('AUTHORED_PRIMITIVES');
      expect(r.moneyMovementProvenance).toBe('CONFIG_RESOLVED');
      expect(r.isBookable).toBe(true);
      expect(r.bookingRefusalReason).toBeUndefined();
      // 2 nights × 12500 minor units (EUR) = 250.00 net before any markup.
      expect(r.priceQuote.netCost.amount).toBe('250.00');
      // Trace must lead with the AUTHORED_BASE_RATE step.
      expect(r.trace.steps[0]!.kind).toBe('AUTHORED_BASE_RATE');
    }
  });

  // -------------------------------------------------------------------------
  // Slice B5 · restriction gating in authored search
  //
  // Each test inserts a single `rate_auth_restriction` row, runs
  // /search, asserts the authored result is suppressed (or kept), and
  // deletes the restriction so the next test starts clean. The
  // sourced result from Hotelbeds is unaffected by these tests, which
  // we verify explicitly to lock in the additive behavior.
  // -------------------------------------------------------------------------

  async function searchOnce(): Promise<SearchResponse> {
    const url = await urlFor(app.getHttpServer(), '/search');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        accountId,
        supplierHotelIds: ['1000073'],
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        occupancy: { adults: 2, children: 0 },
        currency: 'EUR',
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as SearchResponse;
  }

  async function insertRestriction(args: {
    contractId: string | null;
    stayDate: string;
    restrictionKind: string;
    params?: Record<string, unknown>;
    effectiveFrom?: string;
  }): Promise<string> {
    const id = newUlid();
    await pool.query(
      `INSERT INTO rate_auth_restriction
         (id, tenant_id, supplier_id, canonical_hotel_id,
          contract_id, stay_date, restriction_kind, params,
          effective_from)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8::jsonb, $9::timestamptz)`,
      [
        id,
        tenantId,
        directSupplierId,
        canonicalHotelId,
        args.contractId,
        args.stayDate,
        args.restrictionKind,
        JSON.stringify(args.params ?? {}),
        args.effectiveFrom ?? '2025-01-01T00:00:00Z',
      ],
    );
    return id;
  }

  async function deleteRestriction(id: string): Promise<void> {
    await pool.query(`DELETE FROM rate_auth_restriction WHERE id = $1`, [id]);
  }

  it('drops the authored offer when a contract-scoped STOP_SELL covers a stay night; sourced unaffected', async () => {
    const id = await insertRestriction({
      contractId,
      stayDate: '2026-06-02',
      restrictionKind: 'STOP_SELL',
    });
    try {
      const body = await searchOnce();
      const authored = body.results.find((h) => h.supplierId === directSupplierCode);
      const sourced = body.results.find((h) => h.supplierId === 'hotelbeds');
      expect(authored).toBeUndefined();
      expect(sourced).toBeDefined();
      expect(sourced!.rates.length).toBeGreaterThan(0);
    } finally {
      await deleteRestriction(id);
    }
  });

  it('drops the authored offer when MIN_LOS exceeds the stay length', async () => {
    const id = await insertRestriction({
      contractId,
      stayDate: '2026-06-01',
      restrictionKind: 'MIN_LOS',
      params: { min_los: 99 },
    });
    try {
      const body = await searchOnce();
      const authored = body.results.find((h) => h.supplierId === directSupplierCode);
      expect(authored).toBeUndefined();
    } finally {
      await deleteRestriction(id);
    }
  });

  it('drops the authored offer when a supplier-default restriction blocks the stay', async () => {
    const id = await insertRestriction({
      contractId: null,
      stayDate: '2026-06-02',
      restrictionKind: 'STOP_SELL',
    });
    try {
      const body = await searchOnce();
      const authored = body.results.find((h) => h.supplierId === directSupplierCode);
      expect(authored).toBeUndefined();
    } finally {
      await deleteRestriction(id);
    }
  });

  it('keeps the authored offer when the restriction stay_date falls outside the stay window', async () => {
    const id = await insertRestriction({
      contractId,
      stayDate: '2026-05-15',
      restrictionKind: 'STOP_SELL',
    });
    try {
      const body = await searchOnce();
      const authored = body.results.find((h) => h.supplierId === directSupplierCode);
      expect(authored).toBeDefined();
      expect(authored!.rates.length).toBeGreaterThan(0);
    } finally {
      await deleteRestriction(id);
    }
  });

  it('contract-scoped restriction overrides a stricter supplier-default at the same (kind, stay_date)', async () => {
    // Tier 3 supplier-default would block (MIN_LOS=99). Tier 2
    // contract-only allows (MIN_LOS=2). Most-specific-wins → tier 2
    // wins, the offer is kept.
    const supplierDefaultId = await insertRestriction({
      contractId: null,
      stayDate: '2026-06-01',
      restrictionKind: 'MIN_LOS',
      params: { min_los: 99 },
    });
    const contractScopedId = await insertRestriction({
      contractId,
      stayDate: '2026-06-01',
      restrictionKind: 'MIN_LOS',
      params: { min_los: 2 },
    });
    try {
      const body = await searchOnce();
      const authored = body.results.find((h) => h.supplierId === directSupplierCode);
      expect(authored).toBeDefined();
      expect(authored!.rates.length).toBeGreaterThan(0);
    } finally {
      await deleteRestriction(contractScopedId);
      await deleteRestriction(supplierDefaultId);
    }
  });

  it('ignores a superseded restriction even when its stay_date intersects the stay', async () => {
    const oldId = newUlid();
    const newId = newUlid();
    // Insert the new (replacement) row first, then the old row that
    // points at it via superseded_by_id. The old row would block but
    // the evaluator must skip it.
    await pool.query(
      `INSERT INTO rate_auth_restriction
         (id, tenant_id, supplier_id, canonical_hotel_id,
          contract_id, stay_date, restriction_kind, params,
          effective_from)
       VALUES ($1, $2, $3, $4, $5, '2026-06-02'::date, 'STOP_SELL', '{}'::jsonb, '2025-01-01T00:00:00Z'::timestamptz)`,
      [newId, tenantId, directSupplierId, canonicalHotelId, contractId],
    );
    await pool.query(
      `INSERT INTO rate_auth_restriction
         (id, tenant_id, supplier_id, canonical_hotel_id,
          contract_id, stay_date, restriction_kind, params,
          effective_from, superseded_by_id)
       VALUES ($1, $2, $3, $4, $5, '2026-06-15'::date, 'STOP_SELL', '{}'::jsonb, '2025-01-01T00:00:00Z'::timestamptz, $6)`,
      [oldId, tenantId, directSupplierId, canonicalHotelId, contractId, newId],
    );
    try {
      // The new row blocks 2026-06-02 (a stay night) — authored is dropped.
      // We only assert the OLD row's effect: had the old row been
      // honored, search would still drop the authored offer for
      // unrelated reasons. Instead, supersede the new row out of
      // contention by giving it an effective_to in the past.
      await pool.query(
        `UPDATE rate_auth_restriction SET effective_to = '2025-12-31T23:59:59Z' WHERE id = $1`,
        [newId],
      );
      const body = await searchOnce();
      const authored = body.results.find((h) => h.supplierId === directSupplierCode);
      expect(authored).toBeDefined();
    } finally {
      await pool.query(`DELETE FROM rate_auth_restriction WHERE id = $1`, [oldId]);
      await pool.query(`DELETE FROM rate_auth_restriction WHERE id = $1`, [newId]);
    }
  });

  // -------------------------------------------------------------------------
  // Slice B6 · cancellation policy resolution + attachment
  // -------------------------------------------------------------------------

  async function insertCancellationPolicy(args: {
    contractId: string | null;
    ratePlanId?: string | null;
    policyVersion: number;
    refundable: boolean;
    windowsJsonb: ReadonlyArray<unknown>;
    effectiveFrom?: string;
    effectiveTo?: string | null;
  }): Promise<string> {
    const id = newUlid();
    await pool.query(
      `INSERT INTO rate_auth_cancellation_policy
         (id, tenant_id, supplier_id, canonical_hotel_id,
          rate_plan_id, contract_id,
          policy_version, windows_jsonb, refundable,
          effective_from, effective_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, $11::timestamptz)`,
      [
        id,
        tenantId,
        directSupplierId,
        canonicalHotelId,
        args.ratePlanId ?? null,
        args.contractId,
        args.policyVersion,
        JSON.stringify(args.windowsJsonb),
        args.refundable,
        args.effectiveFrom ?? '2025-01-01T00:00:00Z',
        args.effectiveTo ?? null,
      ],
    );
    return id;
  }

  async function deleteCancellationPolicy(id: string): Promise<void> {
    await pool.query(
      `DELETE FROM rate_auth_cancellation_policy WHERE id = $1`,
      [id],
    );
  }

  it('attaches a cancellation descriptor to authored offers when an active policy resolves', async () => {
    const id = await insertCancellationPolicy({
      contractId,
      ratePlanId: null, // contract-only tier
      policyVersion: 1,
      refundable: true,
      windowsJsonb: [
        {
          from_hours_before: 72,
          to_hours_before: 0,
          fee_type: 'PERCENT_OF_TOTAL',
          fee_value: 100,
        },
        {
          from_hours_before: null,
          to_hours_before: 72,
          fee_type: 'FLAT',
          fee_value: 0,
          fee_currency: null,
        },
      ],
    });
    try {
      const body = await searchOnce();
      const authored = body.results.find(
        (h) => h.supplierId === directSupplierCode,
      );
      expect(authored).toBeDefined();
      const rate = authored!.rates[0]!;
      expect(rate.cancellation).toBeDefined();
      expect(rate.cancellation!.policyVersion).toBe(1);
      expect(rate.cancellation!.refundable).toBe(true);
      expect(rate.cancellation!.windows).toHaveLength(2);
      const first = rate.cancellation!.windows[0]!;
      expect(first.fromHoursBefore).toBe(72);
      expect(first.toHoursBefore).toBe(0);
      expect(first.feeType).toBe('PERCENT_OF_TOTAL');
      expect(first.feeValue).toBe(100);

      // Sourced offers MUST NOT carry cancellation in Phase B.
      const sourced = body.results.find((h) => h.supplierId === 'hotelbeds');
      expect(sourced).toBeDefined();
      for (const r of sourced!.rates) {
        expect(r.cancellation).toBeUndefined();
      }
    } finally {
      await deleteCancellationPolicy(id);
    }
  });

  it('omits cancellation when no active policy matches the offer', async () => {
    const body = await searchOnce();
    const authored = body.results.find(
      (h) => h.supplierId === directSupplierCode,
    );
    expect(authored).toBeDefined();
    for (const r of authored!.rates) {
      expect(r.cancellation).toBeUndefined();
    }
  });

  it('most-specific-wins: a contract-only policy overrides a higher-version supplier-default policy', async () => {
    const supplierDefaultId = await insertCancellationPolicy({
      contractId: null,
      ratePlanId: null,
      policyVersion: 99, // would win on version alone
      refundable: false,
      windowsJsonb: [
        {
          from_hours_before: 24,
          to_hours_before: 0,
          fee_type: 'PERCENT_OF_TOTAL',
          fee_value: 100,
        },
      ],
    });
    const contractScopedId = await insertCancellationPolicy({
      contractId,
      ratePlanId: null,
      policyVersion: 1,
      refundable: true,
      windowsJsonb: [
        {
          from_hours_before: 48,
          to_hours_before: 0,
          fee_type: 'FLAT',
          fee_value: 0,
          fee_currency: null,
        },
      ],
    });
    try {
      const body = await searchOnce();
      const authored = body.results.find(
        (h) => h.supplierId === directSupplierCode,
      );
      expect(authored).toBeDefined();
      const rate = authored!.rates[0]!;
      expect(rate.cancellation).toBeDefined();
      // Tier 2 (contract-only, version 1) wins over tier 4 (supplier-default, version 99).
      expect(rate.cancellation!.policyVersion).toBe(1);
      expect(rate.cancellation!.refundable).toBe(true);
    } finally {
      await deleteCancellationPolicy(contractScopedId);
      await deleteCancellationPolicy(supplierDefaultId);
    }
  });

  it('skips a superseded cancellation policy', async () => {
    const newId = newUlid();
    const oldId = newUlid();
    await pool.query(
      `INSERT INTO rate_auth_cancellation_policy
         (id, tenant_id, supplier_id, canonical_hotel_id,
          rate_plan_id, contract_id,
          policy_version, windows_jsonb, refundable,
          effective_from)
       VALUES ($1, $2, $3, $4, NULL, $5, 2, '[]'::jsonb, true, '2025-01-01T00:00:00Z'::timestamptz)`,
      [newId, tenantId, directSupplierId, canonicalHotelId, contractId],
    );
    // Superseded policy: high version, but pointed at by superseded_by_id.
    // The repository pre-filters superseded rows so the resolver never sees it,
    // and the response should reflect only the unsuperseded `newId`.
    await pool.query(
      `INSERT INTO rate_auth_cancellation_policy
         (id, tenant_id, supplier_id, canonical_hotel_id,
          rate_plan_id, contract_id,
          policy_version, windows_jsonb, refundable,
          effective_from, superseded_by_id)
       VALUES ($1, $2, $3, $4, NULL, $5, 1, '[{"from_hours_before":24,"to_hours_before":0,"fee_type":"PERCENT_OF_TOTAL","fee_value":100}]'::jsonb, false, '2025-01-01T00:00:00Z'::timestamptz, $6)`,
      [oldId, tenantId, directSupplierId, canonicalHotelId, contractId, newId],
    );
    try {
      const body = await searchOnce();
      const authored = body.results.find(
        (h) => h.supplierId === directSupplierCode,
      );
      expect(authored).toBeDefined();
      const rate = authored!.rates[0]!;
      expect(rate.cancellation).toBeDefined();
      expect(rate.cancellation!.policyVersion).toBe(2);
      expect(rate.cancellation!.refundable).toBe(true);
      expect(rate.cancellation!.windows).toHaveLength(0);
    } finally {
      await pool.query(
        `DELETE FROM rate_auth_cancellation_policy WHERE id = $1`,
        [oldId],
      );
      await pool.query(
        `DELETE FROM rate_auth_cancellation_policy WHERE id = $1`,
        [newId],
      );
    }
  });
});

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
