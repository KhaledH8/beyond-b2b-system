import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FxModule } from '../fx.module';
import { mapOxrToInputs } from '../oxr-sync.service';
import { OxrClient } from '../oxr-client';

/**
 * Integration tests for POST /internal/fx/oxr-sync and unit tests for
 * the pure `mapOxrToInputs` mapper. Integration tests require the
 * docker DB stack with migrations applied; skipped cleanly when
 * DATABASE_URL is absent.
 *
 * Outbound HTTP to OpenExchangeRates is intercepted via vi.stubGlobal.
 * Non-OXR URLs delegate to the real fetch so the NestJS bootstrap is
 * unaffected.
 */

loadDotenv({ path: path.resolve(__dirname, '../../../../../../.env') });

const TEST_INTERNAL_KEY = 'bb-internal-test-key';
const HAS_DATABASE = Boolean(process.env['DATABASE_URL']);
const describeIntegration = HAS_DATABASE ? describe : describe.skip;

// ─── OXR fixture ─────────────────────────────────────────────────────────────

// Pin to a stable historical timestamp so re-runs against a live DB are
// idempotent. 2025-12-15T12:00:00Z = 1765800000.
const FIXTURE_TS_SECONDS = 1_765_800_000;
const FIXTURE_OBSERVED_AT = new Date(FIXTURE_TS_SECONDS * 1000).toISOString();

const OXR_OK = {
  disclaimer: 'fixture',
  license: 'fixture',
  timestamp: FIXTURE_TS_SECONDS,
  base: 'USD',
  rates: {
    EUR: 0.92,
    GBP: 0.78,
    JPY: 150.25,
  },
};

const OXR_LATEST_PREFIX = 'https://openexchangerates.org/api/latest.json';

// ─── Integration tests ────────────────────────────────────────────────────────

describeIntegration('POST /internal/fx/oxr-sync', () => {
  let app: INestApplication;
  let pool: Pool;

  let mockOxrResponse: 'ok' | 'error' = 'ok';

  beforeAll(async () => {
    process.env['INTERNAL_API_KEY'] = TEST_INTERNAL_KEY;
    process.env['OXR_APP_ID'] = 'test-app-id';

    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(OXR_LATEST_PREFIX)) {
          if (mockOxrResponse === 'error') {
            return new Response('Service Unavailable', { status: 503 });
          }
          return new Response(JSON.stringify(OXR_OK), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=UTF-8' },
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
    if (pool) {
      await pool.query(
        `DELETE FROM fx_rate_snapshot
          WHERE provider = 'OXR' AND observed_at = $1::timestamptz`,
        [FIXTURE_OBSERVED_AT],
      );
      await pool.end();
    }
    if (app) await app.close();
  });

  it('writes OXR snapshots to the DB and returns 201 with metadata', async () => {
    const res = await post(app, '/internal/fx/oxr-sync');
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      provider: string;
      baseCurrency: string;
      observedAt: string;
      pairsTotal: number;
      pairsInserted: number;
    };
    expect(body.provider).toBe('OXR');
    expect(body.baseCurrency).toBe('USD');
    expect(body.observedAt).toBe(FIXTURE_OBSERVED_AT);
    expect(body.pairsTotal).toBe(3);
    expect(body.pairsInserted).toBe(3);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM fx_rate_snapshot
        WHERE provider = 'OXR' AND observed_at = $1::timestamptz`,
      [FIXTURE_OBSERVED_AT],
    );
    expect(rows[0]!.count).toBe('3');
  });

  it('is idempotent — second call inserts 0 rows', async () => {
    const res = await post(app, '/internal/fx/oxr-sync');
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      pairsTotal: number;
      pairsInserted: number;
    };
    expect(body.pairsTotal).toBe(3);
    expect(body.pairsInserted).toBe(0);
  });

  it('returns 401 when x-internal-key header is missing', async () => {
    const url = await urlFor(app.getHttpServer(), '/internal/fx/oxr-sync');
    const res = await fetch(url, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 500 when the OXR upstream returns an error', async () => {
    mockOxrResponse = 'error';
    try {
      const res = await post(app, '/internal/fx/oxr-sync');
      expect(res.status).toBe(500);
    } finally {
      mockOxrResponse = 'ok';
    }
  });
});

// ─── mapOxrToInputs unit tests ──────────────────────────────────────────────

describe('mapOxrToInputs', () => {
  it('maps every rate to a snapshot input with provider=OXR and stamped observedAt', () => {
    let counter = 0;
    const idFactory = (): string =>
      `01ARZ3NDEKTSV4RRFFQ69G5${(counter++).toString().padStart(3, '0')}`;
    const { observedAt, inputs } = mapOxrToInputs(OXR_OK, idFactory);
    expect(observedAt).toBe(FIXTURE_OBSERVED_AT);
    expect(inputs).toHaveLength(3);
    const eur = inputs.find((i) => i.quoteCurrency === 'EUR');
    expect(eur).toBeDefined();
    expect(eur!.provider).toBe('OXR');
    expect(eur!.baseCurrency).toBe('USD');
    expect(eur!.rate).toBe('0.92000000');
    expect(eur!.observedAt).toBe(FIXTURE_OBSERVED_AT);
  });

  it('formats every rate to 8-decimal NUMERIC strings', () => {
    const { inputs } = mapOxrToInputs(
      { base: 'USD', timestamp: FIXTURE_TS_SECONDS, rates: { JPY: 150.25 } },
      () => 'X',
    );
    expect(inputs[0]!.rate).toBe('150.25000000');
  });

  it('returns zero inputs when rates is empty', () => {
    const { inputs } = mapOxrToInputs(
      { base: 'USD', timestamp: FIXTURE_TS_SECONDS, rates: {} },
      () => 'X',
    );
    expect(inputs).toHaveLength(0);
  });

  it('honours a non-USD base on paid plans (e.g. EUR)', () => {
    const { inputs } = mapOxrToInputs(
      {
        base: 'EUR',
        timestamp: FIXTURE_TS_SECONDS,
        rates: { USD: 1.085, GBP: 0.861 },
      },
      () => 'X',
    );
    expect(inputs.every((i) => i.baseCurrency === 'EUR')).toBe(true);
  });
});

// ─── OxrClient unit tests ────────────────────────────────────────────────────

describe('OxrClient', () => {
  it('throws when OXR_APP_ID is empty', async () => {
    const client = new OxrClient({
      appId: '',
      baseUrl: 'https://openexchangerates.org/api',
      baseCurrency: 'USD',
    });
    await expect(client.fetchLatest()).rejects.toThrow(/OXR_APP_ID/);
  });

  it('builds the URL with app_id and omits base when USD', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(OXR_LATEST_PREFIX)) {
          calls.push(url);
          return new Response(JSON.stringify(OXR_OK), { status: 200 });
        }
        return realFetch(input, init);
      },
    );
    try {
      const client = new OxrClient({
        appId: 'k',
        baseUrl: 'https://openexchangerates.org/api',
        baseCurrency: 'USD',
      });
      await client.fetchLatest();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('app_id=k');
      expect(calls[0]).not.toContain('base=');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('appends &base= when baseCurrency is non-USD (paid plan)', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(OXR_LATEST_PREFIX)) {
          calls.push(url);
          return new Response(
            JSON.stringify({ ...OXR_OK, base: 'EUR' }),
            { status: 200 },
          );
        }
        return realFetch(input, init);
      },
    );
    try {
      const client = new OxrClient({
        appId: 'k',
        baseUrl: 'https://openexchangerates.org/api',
        baseCurrency: 'EUR',
      });
      await client.fetchLatest();
      expect(calls[0]).toContain('base=EUR');
    } finally {
      vi.unstubAllGlobals();
    }
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
