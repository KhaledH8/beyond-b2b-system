import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { newUlid } from '../../common/ulid';
import { DatabaseModule } from '../../database/database.module';
import { DirectContractsModule } from '../direct-contracts.module';

/**
 * Integration tests for the DirectContracts admin controllers.
 *
 * Requires the local docker stack (`pnpm db:up`) with migrations applied
 * (`pnpm db:migrate`). Skips cleanly when DATABASE_URL is absent.
 *
 * Each run seeds a fresh tenant, a DIRECT supplier, and a canonical hotel
 * so assertions are scoped and the suite is re-runnable on a live stack.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const TEST_ACTOR_ID = 'test-ops-user';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration(
  'direct-contracts controllers · CRUD over contracts / seasons / age bands',
  () => {
    let app: INestApplication;
    let pool: Pool;
    let tenantId: string;
    let supplierId: string;
    let aggregatorSupplierId: string;
    let hotelId: string;

    beforeAll(async () => {
      process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;

      pool = new Pool({ connectionString: process.env['DATABASE_URL']! });

      // Fresh tenant per run
      tenantId = newUlid();
      const slug = `dc-${randomBytes(6).toString('hex')}`;
      await pool.query(
        `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
        [tenantId, slug, `DC Test Tenant ${slug}`],
      );

      // A DIRECT supplier (the subject of the supplier-type invariant)
      supplierId = newUlid();
      await pool.query(
        `INSERT INTO supply_supplier (id, code, display_name, source_type, status)
         VALUES ($1, $2, 'Test Direct Supplier', 'DIRECT', 'ACTIVE')`,
        [supplierId, `direct-${slug}`],
      );

      // An AGGREGATOR supplier (for the wrong-type rejection test)
      aggregatorSupplierId = newUlid();
      await pool.query(
        `INSERT INTO supply_supplier (id, code, display_name, source_type, status)
         VALUES ($1, $2, 'Test Aggregator', 'AGGREGATOR', 'ACTIVE')`,
        [aggregatorSupplierId, `agg-${slug}`],
      );

      // A canonical hotel (minimal row; name is the only NOT NULL without default)
      hotelId = newUlid();
      await pool.query(
        `INSERT INTO hotel_canonical (id, name) VALUES ($1, $2)`,
        [hotelId, 'Test Hotel'],
      );

      const moduleRef = await Test.createTestingModule({
        imports: [DatabaseModule, DirectContractsModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    }, 30_000);

    afterAll(async () => {
      if (app) await app.close();
      if (pool) await pool.end();
    });

    // -----------------------------------------------------------------------
    // Contract creation
    // -----------------------------------------------------------------------

    describe('POST /internal/admin/direct-contracts/contracts', () => {
      it('creates a contract with a DIRECT supplier — starts as DRAFT', async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-${randomBytes(4).toString('hex')}`,
          currency: 'USD',
        });
        expect(res.status).toBe(201);
        const body: AnyJson = await res.json();
        expect(body.status).toBe('DRAFT');
        expect(body.version).toBe(1);
        expect(body.tenantId).toBe(tenantId);
        expect(body.supplierId).toBe(supplierId);
        expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      });

      it('rejects an AGGREGATOR supplierId with 400 (wrong source_type)', async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId: aggregatorSupplierId,
          contractCode: `CTR-${randomBytes(4).toString('hex')}`,
          currency: 'USD',
        });
        expect(res.status).toBe(400);
      });

      it('rejects an unknown supplierId with 400', async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId: newUlid(),
          contractCode: `CTR-${randomBytes(4).toString('hex')}`,
          currency: 'USD',
        });
        expect(res.status).toBe(400);
      });

      it('rejects an invalid currency (lowercase) with 400', async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-${randomBytes(4).toString('hex')}`,
          currency: 'usd',
        });
        expect(res.status).toBe(400);
      });

      it('rejects validTo before validFrom with 400', async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-${randomBytes(4).toString('hex')}`,
          currency: 'EUR',
          validFrom: '2026-12-01',
          validTo: '2026-06-01',
        });
        expect(res.status).toBe(400);
      });

      it('rejects unknown body keys with 400', async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-${randomBytes(4).toString('hex')}`,
          currency: 'EUR',
          extraField: 'not-allowed',
        });
        expect(res.status).toBe(400);
      });
    });

    // -----------------------------------------------------------------------
    // Contract read / list
    // -----------------------------------------------------------------------

    describe('GET /internal/admin/direct-contracts/contracts', () => {
      let contractId: string;

      beforeAll(async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-LIST-${randomBytes(4).toString('hex')}`,
          currency: 'GBP',
          notes: 'list-test contract',
        });
        const body: AnyJson = await res.json();
        contractId = body.id;
      });

      it('lists contracts filtered by tenantId', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.count).toBeGreaterThan(0);
        for (const r of body.items) {
          expect(r.tenantId).toBe(tenantId);
        }
      });

      it('filters by status=DRAFT', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts?tenantId=${tenantId}&status=DRAFT`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        for (const r of body.items) {
          expect(r.status).toBe('DRAFT');
        }
      });

      it('gets a single contract by id', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.id).toBe(contractId);
        expect(body.notes).toBe('list-test contract');
      });

      it('returns 404 for wrong tenantId', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${newUlid()}`,
        );
        expect(res.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Contract activation invariant + patch
    // -----------------------------------------------------------------------

    describe('PATCH /internal/admin/direct-contracts/contracts', () => {
      let contractId: string;

      beforeAll(async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-PATCH-${randomBytes(4).toString('hex')}`,
          currency: 'AED',
        });
        const body: AnyJson = await res.json();
        contractId = body.id;
      });

      it('rejects ACTIVE transition when contract has no seasons (400)', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
          { status: 'ACTIVE' },
        );
        expect(res.status).toBe(400);
      });

      it('patches notes and signedDocRef while still DRAFT', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
          { notes: 'Updated notes', signedDocRef: 'gs://bucket/doc.pdf' },
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.notes).toBe('Updated notes');
        expect(body.signedDocRef).toBe('gs://bucket/doc.pdf');
        expect(body.status).toBe('DRAFT');
      });

      it('rejects unknown patch keys with 400', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
          { supplierId: newUlid() },
        );
        expect(res.status).toBe(400);
      });

      it('activates contract after a season is added', async () => {
        // Add a season first
        await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons`,
          {
            tenantId,
            name: 'Summer 2026',
            dateFrom: '2026-06-01',
            dateTo: '2026-08-31',
          },
        );

        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
          { status: 'ACTIVE' },
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.status).toBe('ACTIVE');
      });

      it('rejects DRAFT status in PATCH (ACTIVE → DRAFT forbidden)', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
          { status: 'DRAFT' },
        );
        expect(res.status).toBe(400);
      });
    });

    // -----------------------------------------------------------------------
    // Seasons
    // -----------------------------------------------------------------------

    describe('seasons CRUD', () => {
      let contractId: string;
      let seasonId: string;

      beforeAll(async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-SEASON-${randomBytes(4).toString('hex')}`,
          currency: 'USD',
        });
        const body: AnyJson = await res.json();
        contractId = body.id;
      });

      it('creates a season', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons`,
          {
            tenantId,
            name: 'Peak Season',
            dateFrom: '2026-07-01',
            dateTo: '2026-08-31',
          },
        );
        expect(res.status).toBe(201);
        const body: AnyJson = await res.json();
        expect(body.name).toBe('Peak Season');
        expect(body.dateFrom).toBe('2026-07-01');
        expect(body.dateTo).toBe('2026-08-31');
        expect(body.contractId).toBe(contractId);
        seasonId = body.id;
      });

      it('rejects a season that overlaps an existing season (409)', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons`,
          {
            tenantId,
            name: 'Overlapping',
            dateFrom: '2026-08-01',
            dateTo: '2026-09-30',
          },
        );
        expect(res.status).toBe(409);
      });

      it('allows a non-overlapping second season', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons`,
          {
            tenantId,
            name: 'Low Season',
            dateFrom: '2026-09-01',
            dateTo: '2026-10-31',
          },
        );
        expect(res.status).toBe(201);
      });

      it('rejects dateFrom after dateTo (400)', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons`,
          {
            tenantId,
            name: 'Bad dates',
            dateFrom: '2026-12-01',
            dateTo: '2026-11-01',
          },
        );
        expect(res.status).toBe(400);
      });

      it('lists seasons', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.count).toBe(2);
      });

      it('gets one season by id', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons/${seasonId}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.id).toBe(seasonId);
      });

      it('patches season name', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons/${seasonId}?tenantId=${tenantId}`,
          { name: 'High Season' },
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.name).toBe('High Season');
        expect(body.dateFrom).toBe('2026-07-01');
      });

      it('rejects patch that would create overlap (409)', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons/${seasonId}?tenantId=${tenantId}`,
          { dateTo: '2026-09-15' },
        );
        expect(res.status).toBe(409);
      });

      it('returns 404 for season on wrong contract', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${newUlid()}/seasons/${seasonId}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(404);
      });

      it('deletes a season (204)', async () => {
        const res = await del(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons/${seasonId}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(204);

        const after = await get(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons/${seasonId}?tenantId=${tenantId}`,
        );
        expect(after.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Child age bands
    // -----------------------------------------------------------------------

    describe('child age bands CRUD', () => {
      let contractId: string;
      let bandId: string;

      beforeAll(async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-CAB-${randomBytes(4).toString('hex')}`,
          currency: 'USD',
        });
        const body: AnyJson = await res.json();
        contractId = body.id;
      });

      it('creates a child age band', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands`,
          {
            tenantId,
            name: 'Infant',
            ageMin: 0,
            ageMax: 2,
          },
        );
        expect(res.status).toBe(201);
        const body: AnyJson = await res.json();
        expect(body.ageMin).toBe(0);
        expect(body.ageMax).toBe(2);
        expect(body.name).toBe('Infant');
        bandId = body.id;
      });

      it('rejects ageMin > ageMax with 400', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands`,
          { tenantId, name: 'Bad', ageMin: 5, ageMax: 3 },
        );
        expect(res.status).toBe(400);
      });

      it('rejects ageMax > 17 with 400', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands`,
          { tenantId, name: 'Adult', ageMin: 0, ageMax: 18 },
        );
        expect(res.status).toBe(400);
      });

      it('lists child age bands', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.count).toBe(1);
        expect(body.items[0].name).toBe('Infant');
      });

      it('gets one age band by id', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands/${bandId}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.id).toBe(bandId);
      });

      it('patches age band name', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands/${bandId}?tenantId=${tenantId}`,
          { name: 'Baby' },
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.name).toBe('Baby');
      });

      it('deletes a child age band (204)', async () => {
        const res = await del(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands/${bandId}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(204);
      });
    });

    // -----------------------------------------------------------------------
    // Contract soft delete + INACTIVE invariants
    // -----------------------------------------------------------------------

    describe('DELETE (soft delete) and INACTIVE enforcement', () => {
      let contractId: string;

      beforeAll(async () => {
        const res = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `CTR-DEL-${randomBytes(4).toString('hex')}`,
          currency: 'USD',
        });
        const body: AnyJson = await res.json();
        contractId = body.id;
      });

      it('soft-deletes a DRAFT contract → INACTIVE', async () => {
        const res = await del(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body: AnyJson = await res.json();
        expect(body.status).toBe('INACTIVE');
      });

      it('rejects any PATCH on an INACTIVE contract (400)', async () => {
        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
          { notes: 'try to change' },
        );
        expect(res.status).toBe(400);
      });

      it('rejects adding a season to an INACTIVE contract (400)', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons`,
          {
            tenantId,
            name: 'Winter',
            dateFrom: '2026-12-01',
            dateTo: '2026-12-31',
          },
        );
        expect(res.status).toBe(400);
      });

      it('rejects adding a child age band to an INACTIVE contract (400)', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/child-age-bands`,
          { tenantId, name: 'Teen', ageMin: 12, ageMax: 17 },
        );
        expect(res.status).toBe(400);
      });
    });

    // -----------------------------------------------------------------------
    // Audit log
    // -----------------------------------------------------------------------

    describe('audit log', () => {
      it('writes CREATE + PATCH + SOFT_DELETE entries for a contract', async () => {
        const createRes = await post(
          '/internal/admin/direct-contracts/contracts',
          {
            tenantId,
            canonicalHotelId: hotelId,
            supplierId,
            contractCode: `CTR-AUDIT-${randomBytes(4).toString('hex')}`,
            currency: 'USD',
          },
        );
        expect(createRes.status).toBe(201);
        const created: AnyJson = await createRes.json();
        const contractId: string = created.id;

        await patch(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
          { notes: 'audit patch' },
        );

        await del(
          `/internal/admin/direct-contracts/contracts/${contractId}?tenantId=${tenantId}`,
        );

        const { rows } = await pool.query<{ operation: string }>(
          `SELECT operation FROM admin_audit_log
            WHERE resource_id = $1
            ORDER BY created_at ASC`,
          [contractId],
        );
        expect(rows.map((r) => r.operation)).toEqual([
          'CREATE',
          'PATCH',
          'SOFT_DELETE',
        ]);
      });

      it('writes CREATE + DELETE entries for a season', async () => {
        const contractRes = await post(
          '/internal/admin/direct-contracts/contracts',
          {
            tenantId,
            canonicalHotelId: hotelId,
            supplierId,
            contractCode: `CTR-SALOG-${randomBytes(4).toString('hex')}`,
            currency: 'USD',
          },
        );
        const { id: contractId } = (await contractRes.json()) as AnyJson;

        const seasonRes = await post(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons`,
          {
            tenantId,
            name: 'Audit Season',
            dateFrom: '2026-05-01',
            dateTo: '2026-05-31',
          },
        );
        expect(seasonRes.status).toBe(201);
        const { id: seasonId } = (await seasonRes.json()) as AnyJson;

        await del(
          `/internal/admin/direct-contracts/contracts/${contractId}/seasons/${seasonId}?tenantId=${tenantId}`,
        );

        const { rows } = await pool.query<{ operation: string }>(
          `SELECT operation FROM admin_audit_log
            WHERE resource_id = $1
            ORDER BY created_at ASC`,
          [seasonId],
        );
        expect(rows.map((r) => r.operation)).toEqual(['CREATE', 'DELETE']);
      });
    });

    // -----------------------------------------------------------------------
    // Auth
    // -----------------------------------------------------------------------

    describe('unauthenticated requests', () => {
      it('returns 401 when X-Internal-Key is missing', async () => {
        const url = await urlFor(
          app.getHttpServer(),
          '/internal/admin/direct-contracts/contracts',
        );
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            canonicalHotelId: hotelId,
            supplierId,
            contractCode: 'UNAUTH',
            currency: 'USD',
          }),
        });
        expect(res.status).toBe(401);
      });

      it('returns 401 when X-Internal-Key is wrong', async () => {
        const url = await urlFor(
          app.getHttpServer(),
          '/internal/admin/direct-contracts/contracts',
        );
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-key': 'wrong-key',
          },
          body: JSON.stringify({
            tenantId,
            canonicalHotelId: hotelId,
            supplierId,
            contractCode: 'UNAUTH',
            currency: 'USD',
          }),
        });
        expect(res.status).toBe(401);
      });
    });

    // -----------------------------------------------------------------------
    // Slice 3 · base rates
    // -----------------------------------------------------------------------

    describe('base rates · CRUD', () => {
      let brContractId: string;
      let brSeasonId: string;
      let brBaseRateId: string;
      let roomTypeId: string;
      let ratePlanId: string;
      let mealPlanId: string;
      let occTemplateId: string;
      let ageBandId: string;

      beforeAll(async () => {
        const slug = `br-${randomBytes(4).toString('hex')}`;

        // Contract
        const cRes = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `BR-${slug}`,
          currency: 'EUR',
        });
        brContractId = ((await cRes.json()) as AnyJson).id as string;

        // Season
        const sRes = await post(
          `/internal/admin/direct-contracts/contracts/${brContractId}/seasons`,
          { tenantId, name: 'Summer', dateFrom: '2026-06-01', dateTo: '2026-08-31' },
        );
        brSeasonId = ((await sRes.json()) as AnyJson).id as string;

        // Activate contract
        await patch(
          `/internal/admin/direct-contracts/contracts/${brContractId}?tenantId=${tenantId}`,
          { status: 'ACTIVE' },
        );

        // Canonical product dimension rows (hotel-scoped, fresh per run)
        roomTypeId = newUlid();
        await pool.query(
          `INSERT INTO hotel_room_type (id, canonical_hotel_id, code, name)
           VALUES ($1, $2, $3, $4)`,
          [roomTypeId, hotelId, `DBL-${slug}`, 'Double Room'],
        );

        ratePlanId = newUlid();
        await pool.query(
          `INSERT INTO hotel_rate_plan (id, canonical_hotel_id, code, name, rate_class)
           VALUES ($1, $2, $3, $4, $5)`,
          [ratePlanId, hotelId, `FLEX-${slug}`, 'Flexible Rate', 'PUBLIC_BAR'],
        );

        mealPlanId = newUlid();
        await pool.query(
          `INSERT INTO hotel_meal_plan (id, canonical_hotel_id, code, name)
           VALUES ($1, $2, $3, $4)`,
          [mealPlanId, hotelId, `RO-${slug}`, 'Room Only'],
        );

        occTemplateId = newUlid();
        await pool.query(
          `INSERT INTO hotel_occupancy_template
             (id, canonical_hotel_id, room_type_id, base_adults, max_adults, max_children, max_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [occTemplateId, hotelId, roomTypeId, 2, 2, 0, 2],
        );

        ageBandId = newUlid();
        await pool.query(
          `INSERT INTO rate_auth_child_age_band (id, contract_id, name, age_min, age_max)
           VALUES ($1, $2, $3, $4, $5)`,
          [ageBandId, brContractId, 'Child', 2, 11],
        );
      }, 30_000);

      it('creates a base rate', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates`,
          {
            tenantId,
            seasonId: brSeasonId,
            roomTypeId,
            ratePlanId,
            occupancyTemplateId: occTemplateId,
            includedMealPlanId: mealPlanId,
            amountMinorUnits: 15000,
            currency: 'EUR',
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as AnyJson;
        brBaseRateId = body.id as string;
        expect(body.contractId).toBe(brContractId);
        expect(body.seasonId).toBe(brSeasonId);
        expect(body.amountMinorUnits).toBe(15000);
        expect(body.currency).toBe('EUR');
        expect(body.pricingBasis).toBeUndefined();
      });

      it('lists base rates and supports seasonId filter', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates?tenantId=${tenantId}`,
        );
        expect(listRes.status).toBe(200);
        const body = (await listRes.json()) as AnyJson;
        expect(body.count).toBeGreaterThanOrEqual(1);

        const filtered = await get(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates?tenantId=${tenantId}&seasonId=${brSeasonId}`,
        );
        expect(((await filtered.json()) as AnyJson).count).toBeGreaterThanOrEqual(1);
      });

      it('gets a single base rate by id', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates?tenantId=${tenantId}`,
        );
        const listBody = (await listRes.json()) as AnyJson;
        const id = listBody.items[0].id as string;

        const res = await get(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates/${id}?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as AnyJson).id).toBe(id);
      });

      it('patches amountMinorUnits on a base rate', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates?tenantId=${tenantId}`,
        );
        const id = ((await listRes.json()) as AnyJson).items[0].id as string;

        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates/${id}?tenantId=${tenantId}`,
          { amountMinorUnits: 17500 },
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as AnyJson).amountMinorUnits).toBe(17500);
      });

      it('rejects duplicate base rate for same combo', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates`,
          {
            tenantId,
            seasonId: brSeasonId,
            roomTypeId,
            ratePlanId,
            occupancyTemplateId: occTemplateId,
            includedMealPlanId: mealPlanId,
            amountMinorUnits: 9999,
            currency: 'EUR',
          },
        );
        expect(res.status).toBe(409);
      });

      it('rejects negative amountMinorUnits', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates`,
          {
            tenantId,
            seasonId: brSeasonId,
            roomTypeId,
            ratePlanId,
            occupancyTemplateId: occTemplateId,
            includedMealPlanId: mealPlanId,
            amountMinorUnits: -1,
            currency: 'EUR',
          },
        );
        expect(res.status).toBe(400);
      });

      it('rejects unknown FK (bad seasonId)', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates`,
          {
            tenantId,
            seasonId: newUlid(),
            roomTypeId,
            ratePlanId,
            occupancyTemplateId: occTemplateId,
            includedMealPlanId: mealPlanId,
            amountMinorUnits: 10000,
            currency: 'EUR',
          },
        );
        expect(res.status).toBe(409);
      });

      it('blocks base rate creation on INACTIVE contract', async () => {
        const slug2 = `br-inactive-${randomBytes(4).toString('hex')}`;
        const cRes = await post(
          '/internal/admin/direct-contracts/contracts',
          {
            tenantId,
            canonicalHotelId: hotelId,
            supplierId,
            contractCode: `INK-${slug2}`,
            currency: 'EUR',
          },
        );
        const inactiveId = ((await cRes.json()) as AnyJson).id as string;
        await patch(
          `/internal/admin/direct-contracts/contracts/${inactiveId}?tenantId=${tenantId}`,
          { status: 'INACTIVE' },
        );
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${inactiveId}/base-rates`,
          {
            tenantId,
            seasonId: brSeasonId,
            roomTypeId,
            ratePlanId,
            occupancyTemplateId: occTemplateId,
            includedMealPlanId: mealPlanId,
            amountMinorUnits: 10000,
            currency: 'EUR',
          },
        );
        expect(res.status).toBe(400);
      });

      it('deletes a base rate', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates?tenantId=${tenantId}`,
        );
        const items = ((await listRes.json()) as AnyJson).items as AnyJson[];
        const id = items[items.length - 1].id as string;

        const delRes = await del(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates/${id}?tenantId=${tenantId}`,
        );
        expect(delRes.status).toBe(204);

        const getRes = await get(
          `/internal/admin/direct-contracts/contracts/${brContractId}/base-rates/${id}?tenantId=${tenantId}`,
        );
        expect(getRes.status).toBe(404);
      });

      it('records audit log entries for base rate operations', async () => {
        const { rows } = await pool.query<{ operation: string }>(
          `SELECT operation FROM admin_audit_log WHERE resource_id = $1 ORDER BY created_at ASC`,
          [brBaseRateId],
        );
        expect(rows.map((r) => r.operation)).toContain('CREATE');
      });
    });

    // -----------------------------------------------------------------------
    // Slice 3 · occupancy supplements
    // -----------------------------------------------------------------------

    describe('occupancy supplements · CRUD', () => {
      let osContractId: string;
      let osSeasonId: string;
      let osRoomTypeId: string;
      let osRatePlanId: string;
      let osAgeBandId: string;

      beforeAll(async () => {
        const slug = `os-${randomBytes(4).toString('hex')}`;

        const cRes = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `OS-${slug}`,
          currency: 'EUR',
        });
        osContractId = ((await cRes.json()) as AnyJson).id as string;

        const sRes = await post(
          `/internal/admin/direct-contracts/contracts/${osContractId}/seasons`,
          { tenantId, name: 'Winter', dateFrom: '2026-12-01', dateTo: '2026-12-31' },
        );
        osSeasonId = ((await sRes.json()) as AnyJson).id as string;

        await patch(
          `/internal/admin/direct-contracts/contracts/${osContractId}?tenantId=${tenantId}`,
          { status: 'ACTIVE' },
        );

        osRoomTypeId = newUlid();
        await pool.query(
          `INSERT INTO hotel_room_type (id, canonical_hotel_id, code, name)
           VALUES ($1, $2, $3, $4)`,
          [osRoomTypeId, hotelId, `DBL-${slug}`, 'Double Room'],
        );

        osRatePlanId = newUlid();
        await pool.query(
          `INSERT INTO hotel_rate_plan (id, canonical_hotel_id, code, name, rate_class)
           VALUES ($1, $2, $3, $4, $5)`,
          [osRatePlanId, hotelId, `FLEX-${slug}`, 'Flexible Rate', 'PUBLIC_BAR'],
        );

        osAgeBandId = newUlid();
        await pool.query(
          `INSERT INTO rate_auth_child_age_band (id, contract_id, name, age_min, age_max)
           VALUES ($1, $2, $3, $4, $5)`,
          [osAgeBandId, osContractId, 'Child', 2, 11],
        );
      }, 30_000);

      it('creates an EXTRA_ADULT occupancy supplement (no childAgeBandId)', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements`,
          {
            tenantId,
            seasonId: osSeasonId,
            roomTypeId: osRoomTypeId,
            ratePlanId: osRatePlanId,
            occupantKind: 'EXTRA_ADULT',
            amountMinorUnits: 2500,
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as AnyJson;
        expect(body.occupantKind).toBe('EXTRA_ADULT');
        expect(body.childAgeBandId).toBeNull();
        expect(body.pricingBasis).toBe('PER_NIGHT_PER_PERSON');
        expect(body.slotIndex).toBe(1);
      });

      it('creates an EXTRA_CHILD supplement with childAgeBandId', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements`,
          {
            tenantId,
            seasonId: osSeasonId,
            roomTypeId: osRoomTypeId,
            ratePlanId: osRatePlanId,
            occupantKind: 'EXTRA_CHILD',
            childAgeBandId: osAgeBandId,
            amountMinorUnits: 1500,
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as AnyJson;
        expect(body.occupantKind).toBe('EXTRA_CHILD');
        expect(body.childAgeBandId).toBe(osAgeBandId);
      });

      it('rejects EXTRA_CHILD without childAgeBandId', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements`,
          {
            tenantId,
            seasonId: osSeasonId,
            roomTypeId: osRoomTypeId,
            ratePlanId: osRatePlanId,
            occupantKind: 'EXTRA_CHILD',
            amountMinorUnits: 1500,
          },
        );
        expect(res.status).toBe(400);
      });

      it('rejects EXTRA_ADULT with childAgeBandId', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements`,
          {
            tenantId,
            seasonId: osSeasonId,
            roomTypeId: osRoomTypeId,
            ratePlanId: osRatePlanId,
            occupantKind: 'EXTRA_ADULT',
            childAgeBandId: osAgeBandId,
            amountMinorUnits: 2500,
          },
        );
        expect(res.status).toBe(400);
      });

      it('patches amountMinorUnits on an occupancy supplement', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements?tenantId=${tenantId}`,
        );
        const id = ((await listRes.json()) as AnyJson).items[0].id as string;

        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements/${id}?tenantId=${tenantId}`,
          { amountMinorUnits: 3000 },
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as AnyJson).amountMinorUnits).toBe(3000);
      });

      it('rejects extra keys on occupancy supplement patch', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements?tenantId=${tenantId}`,
        );
        const id = ((await listRes.json()) as AnyJson).items[0].id as string;

        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements/${id}?tenantId=${tenantId}`,
          { amountMinorUnits: 1000, occupantKind: 'EXTRA_ADULT' },
        );
        expect(res.status).toBe(400);
      });

      it('blocks INACTIVE contract writes', async () => {
        const slug2 = `os-ink-${randomBytes(4).toString('hex')}`;
        const cRes = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `OSI-${slug2}`,
          currency: 'EUR',
        });
        const inactiveId = ((await cRes.json()) as AnyJson).id as string;
        await patch(
          `/internal/admin/direct-contracts/contracts/${inactiveId}?tenantId=${tenantId}`,
          { status: 'INACTIVE' },
        );
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${inactiveId}/occupancy-supplements`,
          {
            tenantId,
            seasonId: osSeasonId,
            roomTypeId: osRoomTypeId,
            ratePlanId: osRatePlanId,
            occupantKind: 'EXTRA_ADULT',
            amountMinorUnits: 1000,
          },
        );
        expect(res.status).toBe(400);
      });

      it('deletes an occupancy supplement', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements?tenantId=${tenantId}`,
        );
        const id = ((await listRes.json()) as AnyJson).items[0].id as string;

        const delRes = await del(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements/${id}?tenantId=${tenantId}`,
        );
        expect(delRes.status).toBe(204);

        const getRes = await get(
          `/internal/admin/direct-contracts/contracts/${osContractId}/occupancy-supplements/${id}?tenantId=${tenantId}`,
        );
        expect(getRes.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Slice 3 · meal supplements
    // -----------------------------------------------------------------------

    describe('meal supplements · CRUD', () => {
      let msContractId: string;
      let msSeasonId: string;
      let msRoomTypeId: string;
      let msRatePlanId: string;
      let msMealPlanId: string;
      let msAgeBandId: string;

      beforeAll(async () => {
        const slug = `ms-${randomBytes(4).toString('hex')}`;

        const cRes = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `MS-${slug}`,
          currency: 'EUR',
        });
        msContractId = ((await cRes.json()) as AnyJson).id as string;

        const sRes = await post(
          `/internal/admin/direct-contracts/contracts/${msContractId}/seasons`,
          { tenantId, name: 'Spring', dateFrom: '2026-04-01', dateTo: '2026-05-31' },
        );
        msSeasonId = ((await sRes.json()) as AnyJson).id as string;

        await patch(
          `/internal/admin/direct-contracts/contracts/${msContractId}?tenantId=${tenantId}`,
          { status: 'ACTIVE' },
        );

        msRoomTypeId = newUlid();
        await pool.query(
          `INSERT INTO hotel_room_type (id, canonical_hotel_id, code, name)
           VALUES ($1, $2, $3, $4)`,
          [msRoomTypeId, hotelId, `DBL-${slug}`, 'Double Room'],
        );

        msRatePlanId = newUlid();
        await pool.query(
          `INSERT INTO hotel_rate_plan (id, canonical_hotel_id, code, name, rate_class)
           VALUES ($1, $2, $3, $4, $5)`,
          [msRatePlanId, hotelId, `FLEX-${slug}`, 'Flexible Rate', 'PUBLIC_BAR'],
        );

        msMealPlanId = newUlid();
        await pool.query(
          `INSERT INTO hotel_meal_plan (id, canonical_hotel_id, code, name)
           VALUES ($1, $2, $3, $4)`,
          [msMealPlanId, hotelId, `BB-${slug}`, 'Bed and Breakfast'],
        );

        msAgeBandId = newUlid();
        await pool.query(
          `INSERT INTO rate_auth_child_age_band (id, contract_id, name, age_min, age_max)
           VALUES ($1, $2, $3, $4, $5)`,
          [msAgeBandId, msContractId, 'Child', 2, 11],
        );
      }, 30_000);

      it('creates an ADULT meal supplement (no childAgeBandId, no room/plan scope)', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements`,
          {
            tenantId,
            seasonId: msSeasonId,
            targetMealPlanId: msMealPlanId,
            occupantKind: 'ADULT',
            amountMinorUnits: 1200,
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as AnyJson;
        expect(body.occupantKind).toBe('ADULT');
        expect(body.childAgeBandId).toBeNull();
        expect(body.roomTypeId).toBeNull();
        expect(body.ratePlanId).toBeNull();
        expect(body.pricingBasis).toBe('PER_NIGHT_PER_PERSON');
      });

      it('creates a CHILD meal supplement with childAgeBandId', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements`,
          {
            tenantId,
            seasonId: msSeasonId,
            targetMealPlanId: msMealPlanId,
            occupantKind: 'CHILD',
            childAgeBandId: msAgeBandId,
            amountMinorUnits: 600,
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as AnyJson;
        expect(body.occupantKind).toBe('CHILD');
        expect(body.childAgeBandId).toBe(msAgeBandId);
      });

      it('creates a meal supplement scoped to room type and rate plan', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements`,
          {
            tenantId,
            seasonId: msSeasonId,
            roomTypeId: msRoomTypeId,
            ratePlanId: msRatePlanId,
            targetMealPlanId: msMealPlanId,
            occupantKind: 'ADULT',
            amountMinorUnits: 1500,
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as AnyJson;
        expect(body.roomTypeId).toBe(msRoomTypeId);
        expect(body.ratePlanId).toBe(msRatePlanId);
      });

      it('rejects CHILD without childAgeBandId', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements`,
          {
            tenantId,
            seasonId: msSeasonId,
            targetMealPlanId: msMealPlanId,
            occupantKind: 'CHILD',
            amountMinorUnits: 600,
          },
        );
        expect(res.status).toBe(400);
      });

      it('rejects ADULT with childAgeBandId', async () => {
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements`,
          {
            tenantId,
            seasonId: msSeasonId,
            targetMealPlanId: msMealPlanId,
            occupantKind: 'ADULT',
            childAgeBandId: msAgeBandId,
            amountMinorUnits: 1200,
          },
        );
        expect(res.status).toBe(400);
      });

      it('lists meal supplements and supports seasonId filter', async () => {
        const res = await get(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements?tenantId=${tenantId}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as AnyJson;
        expect(body.count).toBeGreaterThanOrEqual(1);

        const filtered = await get(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements?tenantId=${tenantId}&seasonId=${msSeasonId}`,
        );
        expect(((await filtered.json()) as AnyJson).count).toBeGreaterThanOrEqual(1);
      });

      it('patches amountMinorUnits on a meal supplement', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements?tenantId=${tenantId}`,
        );
        const id = ((await listRes.json()) as AnyJson).items[0].id as string;

        const res = await patch(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements/${id}?tenantId=${tenantId}`,
          { amountMinorUnits: 2000 },
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as AnyJson).amountMinorUnits).toBe(2000);
      });

      it('blocks meal supplement creation on INACTIVE contract', async () => {
        const slug2 = `ms-ink-${randomBytes(4).toString('hex')}`;
        const cRes = await post('/internal/admin/direct-contracts/contracts', {
          tenantId,
          canonicalHotelId: hotelId,
          supplierId,
          contractCode: `MSI-${slug2}`,
          currency: 'EUR',
        });
        const inactiveId = ((await cRes.json()) as AnyJson).id as string;
        await patch(
          `/internal/admin/direct-contracts/contracts/${inactiveId}?tenantId=${tenantId}`,
          { status: 'INACTIVE' },
        );
        const res = await post(
          `/internal/admin/direct-contracts/contracts/${inactiveId}/meal-supplements`,
          {
            tenantId,
            seasonId: msSeasonId,
            targetMealPlanId: msMealPlanId,
            occupantKind: 'ADULT',
            amountMinorUnits: 1000,
          },
        );
        expect(res.status).toBe(400);
      });

      it('deletes a meal supplement', async () => {
        const listRes = await get(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements?tenantId=${tenantId}`,
        );
        const id = ((await listRes.json()) as AnyJson).items[0].id as string;

        const delRes = await del(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements/${id}?tenantId=${tenantId}`,
        );
        expect(delRes.status).toBe(204);

        const getRes = await get(
          `/internal/admin/direct-contracts/contracts/${msContractId}/meal-supplements/${id}?tenantId=${tenantId}`,
        );
        expect(getRes.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // HTTP helpers
    // -----------------------------------------------------------------------

    async function post(path: string, body: unknown): Promise<Response> {
      const url = await urlFor(app.getHttpServer(), path);
      return fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': TEST_INTERNAL_KEY,
          'x-actor-id': TEST_ACTOR_ID,
        },
        body: JSON.stringify(body),
      });
    }

    async function patch(path: string, body: unknown): Promise<Response> {
      const url = await urlFor(app.getHttpServer(), path);
      return fetch(url, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': TEST_INTERNAL_KEY,
          'x-actor-id': TEST_ACTOR_ID,
        },
        body: JSON.stringify(body),
      });
    }

    async function del(path: string): Promise<Response> {
      const url = await urlFor(app.getHttpServer(), path);
      return fetch(url, {
        method: 'DELETE',
        headers: {
          'x-internal-key': TEST_INTERNAL_KEY,
          'x-actor-id': TEST_ACTOR_ID,
        },
      });
    }

    async function get(path: string): Promise<Response> {
      const url = await urlFor(app.getHttpServer(), path);
      return fetch(url, {
        headers: { 'x-internal-key': TEST_INTERNAL_KEY },
      });
    }
  },
);

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;
