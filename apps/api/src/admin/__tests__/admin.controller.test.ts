import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { newUlid } from '../../common/ulid';
import { AdminModule } from '../admin.module';
import { AdaptersModule } from '../../adapters/adapters.module';
import { DatabaseModule } from '../../database/database.module';
import { ObjectStorageModule } from '../../object-storage/object-storage.module';

/**
 * Integration tests for the internal admin controllers.
 *
 * Boots Nest with `AdminModule` plus the adapter / object-storage
 * graph (the latter so HotelbedsModule's `onModuleInit` can register
 * the supplier — markup-rule HOTEL scope keys on `hotel_supplier.id`,
 * which requires the supplier row to exist before content sync).
 *
 * Drives both controllers through real HTTP, asserts:
 *   - create per scope (markup) and per kind (promotion)
 *   - get / list with filters
 *   - patch only the allowed fields
 *   - patch reject extra / immutable fields with 400
 *   - soft-delete sets status=INACTIVE
 *   - validation rejects malformed bodies
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const TEST_ACTOR_ID = 'test-ops-user';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('admin controllers · CRUD over pricing + merchandising', () => {
  let app: INestApplication;
  let pool: Pool;
  let tenantId: string;
  let accountId: string;
  let supplierHotelId: string;

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
    const slug = `adm-${randomBytes(6).toString('hex')}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Admin Test Tenant ${slug}`],
    );
    await pool.query(
      `INSERT INTO core_account (id, tenant_id, account_type, name)
         VALUES ($1, $2, 'AGENCY', 'Admin Test Agency')`,
      [accountId, tenantId],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        ObjectStorageModule,
        AdaptersModule,
        AdminModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // Run a content sync so hotel_supplier has the fixture row that
    // HOTEL-scope rules and promotions FK into.
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
    const { rows } = await pool.query<{ id: string }>(
      `SELECT hs.id FROM hotel_supplier hs
         JOIN supply_supplier s ON s.id = hs.supplier_id
        WHERE s.code = 'hotelbeds' AND hs.supplier_hotel_code = '1000073'`,
    );
    supplierHotelId = rows[0]!.id;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  // ---------------------------------------------------------------
  // Markup rules
  // ---------------------------------------------------------------

  describe('POST /internal/admin/pricing/markup-rules', () => {
    it('creates a CHANNEL rule with status=ACTIVE', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'CHANNEL',
        accountType: 'AGENCY',
        percentValue: '7.5000',
        priority: 10,
      });
      expect(res.status).toBe(201);
      const body: AnyJson = await res.json();
      expect(body.scope).toBe('CHANNEL');
      expect(body.accountType).toBe('AGENCY');
      expect(body.percentValue).toBe('7.5000');
      expect(body.status).toBe('ACTIVE');
      expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('creates an ACCOUNT rule', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'ACCOUNT',
        accountId,
        percentValue: '12.0000',
        priority: 0,
      });
      expect(res.status).toBe(201);
      const body: AnyJson = await res.json();
      expect(body.scope).toBe('ACCOUNT');
      expect(body.accountId).toBe(accountId);
    });

    it('creates a HOTEL rule', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'HOTEL',
        supplierHotelId,
        percentValue: '15.0000',
        priority: 0,
      });
      expect(res.status).toBe(201);
      const body: AnyJson = await res.json();
      expect(body.scope).toBe('HOTEL');
      expect(body.supplierHotelId).toBe(supplierHotelId);
    });

    it('rejects scope=ACCOUNT without accountId (400)', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'ACCOUNT',
        percentValue: '5.0000',
        priority: 0,
      });
      expect(res.status).toBe(400);
    });

    it('rejects scope=CHANNEL with accountId (cross-scope keys) 400', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'CHANNEL',
        accountType: 'AGENCY',
        accountId, // must not be present for CHANNEL scope
        percentValue: '5.0000',
        priority: 0,
      });
      expect(res.status).toBe(400);
    });

    it('rejects malformed percentValue (400)', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'CHANNEL',
        accountType: 'AGENCY',
        percentValue: '12.345678', // > 4 fractional digits
        priority: 0,
      });
      expect(res.status).toBe(400);
    });

    it('rejects unknown body keys (400)', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'CHANNEL',
        accountType: 'AGENCY',
        percentValue: '5.0000',
        priority: 0,
        notARealField: 'whatever',
      });
      expect(res.status).toBe(400);
    });

    it('rejects validTo <= validFrom (400)', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'CHANNEL',
        accountType: 'AGENCY',
        percentValue: '5.0000',
        priority: 0,
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2026-01-01T00:00:00Z',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /internal/admin/pricing/markup-rules', () => {
    it('filters by tenantId and scope', async () => {
      const res = await get(
        `/internal/admin/pricing/markup-rules?tenantId=${tenantId}&scope=CHANNEL`,
      );
      expect(res.status).toBe(200);
      const body: AnyJson = await res.json();
      expect(body.count).toBeGreaterThan(0);
      for (const r of body.items) {
        expect(r.tenantId).toBe(tenantId);
        expect(r.scope).toBe('CHANNEL');
      }
    });
  });

  describe('PATCH + DELETE /internal/admin/pricing/markup-rules', () => {
    let ruleId: string;

    beforeAll(async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'CHANNEL',
        accountType: 'B2C',
        percentValue: '3.0000',
        priority: 0,
      });
      const body: AnyJson = await res.json();
      ruleId = body.id;
    });

    it('patches percentValue and priority', async () => {
      const res = await patch(
        `/internal/admin/pricing/markup-rules/${ruleId}?tenantId=${tenantId}`,
        { percentValue: '4.5000', priority: 99 },
      );
      expect(res.status).toBe(200);
      const body: AnyJson = await res.json();
      expect(body.percentValue).toBe('4.5000');
      expect(body.priority).toBe(99);
      // Scope and key did not change.
      expect(body.scope).toBe('CHANNEL');
      expect(body.accountType).toBe('B2C');
    });

    it('rejects patch on immutable field (400)', async () => {
      const res = await patch(
        `/internal/admin/pricing/markup-rules/${ruleId}?tenantId=${tenantId}`,
        { scope: 'ACCOUNT' },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 when tenantId does not own the rule', async () => {
      const wrongTenantId = newUlid();
      const res = await get(
        `/internal/admin/pricing/markup-rules/${ruleId}?tenantId=${wrongTenantId}`,
      );
      expect(res.status).toBe(404);
    });

    it('soft-deletes via DELETE (status=INACTIVE)', async () => {
      const res = await del(
        `/internal/admin/pricing/markup-rules/${ruleId}?tenantId=${tenantId}`,
      );
      expect(res.status).toBe(200);
      const body: AnyJson = await res.json();
      expect(body.status).toBe('INACTIVE');

      // Read-back confirms persistence and that the row is still
      // retrievable for audit (soft delete only).
      const after = await get(
        `/internal/admin/pricing/markup-rules/${ruleId}?tenantId=${tenantId}`,
      );
      expect(after.status).toBe(200);
      const afterBody: AnyJson = await after.json();
      expect(afterBody.status).toBe('INACTIVE');
    });
  });

  // ---------------------------------------------------------------
  // Promotions
  // ---------------------------------------------------------------

  describe('POST /internal/admin/merchandising/promotions', () => {
    it('creates a PROMOTED tag scoped to AGENCY channel', async () => {
      const res = await post('/internal/admin/merchandising/promotions', {
        tenantId,
        supplierHotelId,
        kind: 'PROMOTED',
        priority: 100,
        accountType: 'AGENCY',
      });
      expect(res.status).toBe(201);
      const body: AnyJson = await res.json();
      expect(body.kind).toBe('PROMOTED');
      expect(body.accountType).toBe('AGENCY');
      expect(body.status).toBe('ACTIVE');
    });

    it('rejects unknown kind (400)', async () => {
      const res = await post('/internal/admin/merchandising/promotions', {
        tenantId,
        supplierHotelId,
        kind: 'NOT_A_KIND',
        priority: 0,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /internal/admin/merchandising/promotions', () => {
    let promoId: string;

    beforeAll(async () => {
      const res = await post('/internal/admin/merchandising/promotions', {
        tenantId,
        supplierHotelId,
        kind: 'RECOMMENDED',
        priority: 5,
        accountType: 'B2C',
      });
      const body: AnyJson = await res.json();
      promoId = body.id;
    });

    it('clears accountType when patched with null', async () => {
      const res = await patch(
        `/internal/admin/merchandising/promotions/${promoId}?tenantId=${tenantId}`,
        { accountType: null },
      );
      expect(res.status).toBe(200);
      const body: AnyJson = await res.json();
      expect(body.accountType).toBeNull();
    });

    it('updates kind and priority', async () => {
      const res = await patch(
        `/internal/admin/merchandising/promotions/${promoId}?tenantId=${tenantId}`,
        { kind: 'FEATURED', priority: 50 },
      );
      expect(res.status).toBe(200);
      const body: AnyJson = await res.json();
      expect(body.kind).toBe('FEATURED');
      expect(body.priority).toBe(50);
    });

    it('rejects patching supplier_hotel_id (immutable)', async () => {
      const res = await patch(
        `/internal/admin/merchandising/promotions/${promoId}?tenantId=${tenantId}`,
        { supplierHotelId: newUlid() },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 when tenantId does not own the promotion', async () => {
      const wrongTenantId = newUlid();
      const res = await patch(
        `/internal/admin/merchandising/promotions/${promoId}?tenantId=${wrongTenantId}`,
        { priority: 1 },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /internal/admin/merchandising/promotions', () => {
    it('lists by tenant + supplierHotelId', async () => {
      const res = await get(
        `/internal/admin/merchandising/promotions?tenantId=${tenantId}&supplierHotelId=${supplierHotelId}`,
      );
      expect(res.status).toBe(200);
      const body: AnyJson = await res.json();
      expect(body.count).toBeGreaterThan(0);
      for (const r of body.items) {
        expect(r.supplierHotelId).toBe(supplierHotelId);
      }
    });
  });

  // ---------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------

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
      method: 'GET',
      headers: { 'x-internal-key': TEST_INTERNAL_KEY },
    });
  }

  describe('audit log', () => {
    it('writes a CREATE entry for markup rule', async () => {
      const res = await post('/internal/admin/pricing/markup-rules', {
        tenantId,
        scope: 'CHANNEL',
        accountType: 'SUBSCRIBER',
        percentValue: '2.0000',
        priority: 0,
      });
      expect(res.status).toBe(201);
      const body: AnyJson = await res.json();
      const { rows } = await pool.query<{
        actor_id: string;
        operation: string;
        resource_type: string;
      }>(
        `SELECT actor_id, operation, resource_type
           FROM admin_audit_log
          WHERE resource_id = $1`,
        [body.id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.actor_id).toBe(TEST_ACTOR_ID);
      expect(rows[0]!.operation).toBe('CREATE');
      expect(rows[0]!.resource_type).toBe('markup_rule');
    });

    it('writes CREATE, PATCH, SOFT_DELETE entries for a promotion', async () => {
      const createRes = await post('/internal/admin/merchandising/promotions', {
        tenantId,
        supplierHotelId,
        kind: 'FEATURED',
        priority: 1,
      });
      expect(createRes.status).toBe(201);
      const created: AnyJson = await createRes.json();
      const promoId: string = created.id;

      await patch(
        `/internal/admin/merchandising/promotions/${promoId}?tenantId=${tenantId}`,
        { priority: 2 },
      );

      const url = await urlFor(
        app.getHttpServer(),
        `/internal/admin/merchandising/promotions/${promoId}?tenantId=${tenantId}`,
      );
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'x-internal-key': TEST_INTERNAL_KEY,
          'x-actor-id': TEST_ACTOR_ID,
        },
      });

      const { rows } = await pool.query<{ operation: string }>(
        `SELECT operation FROM admin_audit_log
          WHERE resource_id = $1
          ORDER BY created_at ASC`,
        [promoId],
      );
      expect(rows.map((r) => r.operation)).toEqual([
        'CREATE',
        'PATCH',
        'SOFT_DELETE',
      ]);
    });
  });

  describe('unauthenticated requests', () => {
    it('returns 401 when X-Internal-Key header is missing', async () => {
      const url = await urlFor(
        app.getHttpServer(),
        '/internal/admin/pricing/markup-rules',
      );
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          scope: 'CHANNEL',
          accountType: 'AGENCY',
          percentValue: '5.0000',
          priority: 0,
        }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when X-Internal-Key header is wrong', async () => {
      const url = await urlFor(
        app.getHttpServer(),
        '/internal/admin/pricing/markup-rules',
      );
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': 'wrong-key',
        },
        body: JSON.stringify({
          tenantId,
          scope: 'CHANNEL',
          accountType: 'AGENCY',
          percentValue: '5.0000',
          priority: 0,
        }),
      });
      expect(res.status).toBe(401);
    });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;
