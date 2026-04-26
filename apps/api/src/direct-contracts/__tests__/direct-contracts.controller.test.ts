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
