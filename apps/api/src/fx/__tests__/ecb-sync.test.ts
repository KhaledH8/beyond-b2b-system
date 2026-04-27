import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FxModule } from '../fx.module';
import { parseEcbXml } from '../ecb-fetcher.service';

/**
 * Integration tests for POST /internal/fx/ecb-sync and unit tests for
 * parseEcbXml. Integration tests require the docker DB stack with
 * migrations applied; skipped cleanly when DATABASE_URL is absent.
 *
 * Outbound fetch to the real ECB URL is intercepted via vi.stubGlobal so
 * the suite is deterministic and does not depend on network availability.
 * Non-ECB URLs are delegated to the real fetch to leave the NestJS
 * bootstrap unaffected.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

// ─── ECB fixture ─────────────────────────────────────────────────────────────

// Use a historical date so re-runs on a live DB remain idempotent even if
// the test data is not cleaned up. 2025-12-15 is past and not a real ECB
// publication that the DB is likely to already contain.
const FIXTURE_DATE = '2025-12-15';

function makeEcbXml(date: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
                 xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='${date}'>
      <Cube currency='USD' rate='1.0850'/>
      <Cube currency='GBP' rate='0.8610'/>
      <Cube currency='JPY' rate='163.45'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;
}

const ECB_XML_OK = makeEcbXml(FIXTURE_DATE);
const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

// ─── Integration tests ────────────────────────────────────────────────────────

describeIntegration('POST /internal/fx/ecb-sync', () => {
  let app: INestApplication;
  let pool: Pool;

  // Controls whether the mocked fetch returns a successful ECB response or an
  // upstream error. Shared across tests via closure so we do not re-stub.
  let mockEcbResponse: 'ok' | 'error' = 'ok';

  beforeAll(async () => {
    process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;

    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });

    // Capture real fetch before stubbing so non-ECB requests (NestJS bootstrap
    // HTTP calls, etc.) are not affected.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === ECB_URL) {
          if (mockEcbResponse === 'error') {
            return new Response('Service Unavailable', { status: 503 });
          }
          return new Response(ECB_XML_OK, {
            status: 200,
            headers: { 'content-type': 'application/xml; charset=UTF-8' },
          });
        }
        return realFetch(input, init);
      },
    );

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, FxModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    // Clean up fixture rows so re-runs start clean.
    if (pool) {
      await pool.query(
        `DELETE FROM fx_rate_snapshot
          WHERE provider = 'ECB' AND observed_at = $1::timestamptz`,
        [`${FIXTURE_DATE}T00:00:00Z`],
      );
      await pool.end();
    }
    if (app) await app.close();
  });

  it('writes ECB snapshots to the DB and returns 201 with correct metadata', async () => {
    const res = await post(app, '/internal/fx/ecb-sync');
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      provider: string;
      observedAt: string;
      pairsTotal: number;
      pairsInserted: number;
    };
    expect(body.provider).toBe('ECB');
    expect(body.observedAt).toBe(`${FIXTURE_DATE}T00:00:00Z`);
    expect(body.pairsTotal).toBe(3);
    expect(body.pairsInserted).toBe(3);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM fx_rate_snapshot
        WHERE provider = 'ECB' AND observed_at = $1::timestamptz`,
      [`${FIXTURE_DATE}T00:00:00Z`],
    );
    expect(rows[0]!.count).toBe('3');
  });

  it('is idempotent — second call inserts 0 rows', async () => {
    const res = await post(app, '/internal/fx/ecb-sync');
    expect(res.status).toBe(201);

    const body = (await res.json()) as { pairsInserted: number; pairsTotal: number };
    expect(body.pairsTotal).toBe(3);
    expect(body.pairsInserted).toBe(0);
  });

  it('returns 401 when x-internal-key header is missing', async () => {
    const url = await urlFor(app.getHttpServer(), '/internal/fx/ecb-sync');
    const res = await fetch(url, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 500 when the ECB upstream returns an error', async () => {
    mockEcbResponse = 'error';
    try {
      const res = await post(app, '/internal/fx/ecb-sync');
      expect(res.status).toBe(500);
    } finally {
      mockEcbResponse = 'ok';
    }
  });
});

// ─── parseEcbXml unit tests ──────────────────────────────────────────────────

describe('parseEcbXml', () => {
  it('parses a well-formed ECB envelope with single-quoted attributes', () => {
    const xml = makeEcbXml('2025-01-10');
    const result = parseEcbXml(xml);
    expect(result.observedAt).toBe('2025-01-10T00:00:00Z');
    expect(result.pairs).toHaveLength(3);
    expect(result.pairs[0]).toEqual({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.0850',
    });
  });

  it('parses a well-formed ECB envelope with double-quoted attributes', () => {
    const xml = `<Cube time="2025-03-21"><Cube currency="CHF" rate="0.9612"/></Cube>`;
    const result = parseEcbXml(xml);
    expect(result.observedAt).toBe('2025-03-21T00:00:00Z');
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toEqual({
      baseCurrency: 'EUR',
      quoteCurrency: 'CHF',
      rate: '0.9612',
    });
  });

  it('throws when publication date is missing', () => {
    expect(() => parseEcbXml('<Cube currency="USD" rate="1.08"/>')).toThrow(
      'ECB XML: could not find publication date',
    );
  });

  it('returns zero pairs when no currency nodes are present', () => {
    const xml = `<Cube time='2025-06-01'></Cube>`;
    const result = parseEcbXml(xml);
    expect(result.observedAt).toBe('2025-06-01T00:00:00Z');
    expect(result.pairs).toHaveLength(0);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function post(app: INestApplication, p: string): Promise<Response> {
  const url = await urlFor(app.getHttpServer(), p);
  return fetch(url, {
    method: 'POST',
    headers: { 'x-internal-key': TEST_INTERNAL_KEY },
  });
}

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
