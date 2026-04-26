import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { newUlid } from '../../../common/ulid';
import { AdaptersModule } from '../../adapters.module';
import { DatabaseModule } from '../../../database/database.module';
import { ObjectStorageModule } from '../../../object-storage/object-storage.module';

/**
 * Integration test for the internal Hotelbeds controller. Boots a
 * real Nest application with the adapter wired in `fixture` mode,
 * then drives both endpoints over HTTP and asserts the responses.
 *
 * Skips cleanly when `DATABASE_URL` is absent so CI without a local
 * stack does not fail. Forces `HOTELBEDS_CLIENT_KIND=fixture` and
 * `HOTELBEDS_FIXTURE_DIR` at the start of the test run so the wiring
 * picks up the in-repo fixtures regardless of the developer's `.env`.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../../.env') });

const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

describeIntegration('hotelbeds controller · internal seam (fixture mode)', () => {
  let app: INestApplication;
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    process.env['HOTELBEDS_CLIENT_KIND'] = 'fixture';
    process.env['HOTELBEDS_FIXTURE_DIR'] = path.resolve(
      __dirname,
      '../../../../../../packages/testing/src/hotelbeds/fixtures',
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
    const slug = `ctrl-${randomBytes(6).toString('hex')}`;
    await pool.query(
      `INSERT INTO core_tenant (id, slug, display_name) VALUES ($1, $2, $3)`,
      [tenantId, slug, `Controller Test Tenant ${slug}`],
    );

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, ObjectStorageModule, AdaptersModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  it('POST /internal/suppliers/hotelbeds/content-sync returns counts and current kind', async () => {
    const server = app.getHttpServer() as Parameters<typeof fetch>[0];
    const url = await urlFor(server, '/internal/suppliers/hotelbeds/content-sync');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId, pageSize: 50, maxPages: 1 }),
    });
    expect(res.status).toBe(201); // Nest @Post defaults to 201 unless overridden
    const body = (await res.json()) as {
      supplier: string;
      clientKind: string;
      tenantId: string;
      pagesFetched: number;
      hotelsUpserted: number;
    };
    expect(body.supplier).toBe('hotelbeds');
    expect(body.clientKind).toBe('fixture');
    expect(body.tenantId).toBe(tenantId);
    expect(body.pagesFetched).toBe(1);
    expect(body.hotelsUpserted).toBeGreaterThan(0);
  });

  it('POST /internal/suppliers/hotelbeds/search returns rates with isBookable=false', async () => {
    const server = app.getHttpServer() as Parameters<typeof fetch>[0];
    const url = await urlFor(server, '/internal/suppliers/hotelbeds/search');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        supplierHotelId: '1000073',
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        occupancy: { adults: 2, children: 0 },
        currency: 'EUR',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      supplier: string;
      clientKind: string;
      rateCount: number;
      rates: Array<{
        roomType: string;
        ratePlan: string;
        moneyMovementProvenance: string;
        isBookable: boolean;
        bookingRefusalReason?: string;
      }>;
    };
    expect(body.supplier).toBe('hotelbeds');
    expect(body.clientKind).toBe('fixture');
    expect(body.rateCount).toBeGreaterThan(0);
    for (const r of body.rates) {
      expect(r.roomType).toBe('DBL.ST');
      expect(r.moneyMovementProvenance).toBe('PROVISIONAL');
      expect(r.isBookable).toBe(false);
      expect(r.bookingRefusalReason).toMatch(/PROVISIONAL/);
    }
  });

  it('rejects invalid bodies with 400', async () => {
    const server = app.getHttpServer() as Parameters<typeof fetch>[0];
    const url = await urlFor(server, '/internal/suppliers/hotelbeds/search');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId, supplierHotelId: '1000073' }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * Bind the Nest in-memory HTTP server to a port, return a URL for the
 * given path. Nest's `getHttpServer()` returns a Node `http.Server`;
 * `app.listen(0)` lets the OS choose a free port and writes it back.
 */
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
