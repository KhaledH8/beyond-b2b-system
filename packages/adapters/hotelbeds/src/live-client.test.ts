import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HotelbedsHttpError,
  createLiveHotelbedsClient,
  signHotelbedsRequest,
} from './live-client';

/**
 * Unit-level guards for the live HTTP client.
 *
 * These tests deliberately do NOT hit the Hotelbeds network. They pin
 * the two load-bearing primitives — request signing and the
 * retry/backoff state machine — against a stubbed `fetch`. End-to-end
 * exercise of the live path lives in the conformance suite once
 * recorded fixtures from real traffic are available.
 */

describe('signHotelbedsRequest', () => {
  it('matches sha256_hex(apiKey + secret + epochSeconds)', () => {
    // Public docs example shape: SHA256 hex over the concatenated string.
    // We pin the algorithm against a known vector here so a regression in
    // the auth path fails this test before it ever hits Hotelbeds.
    const apiKey = 'demo-key';
    const secret = 'demo-secret';
    const ts = 1700000000;
    const expected = createHash('sha256')
      .update(`${apiKey}${secret}${ts}`)
      .digest('hex');
    expect(signHotelbedsRequest(apiKey, secret, ts)).toBe(expected);
  });
});

describe('createLiveHotelbedsClient (transport)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // setTimeout is patched to no-op so retry backoffs do not block
    // the test suite. Vitest fake timers do not interact with the
    // promise microtask queue we need here, so a direct stub is simpler.
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      Promise.resolve().then(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('attaches Api-key and X-Signature on every request', async () => {
    const seen: Array<{ headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      const h = (init as RequestInit).headers as Record<string, string>;
      seen.push({ headers: h });
      return makeJsonResponse({ hotels: [], total: 0 });
    }) as typeof fetch;

    const client = createLiveHotelbedsClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://api.test.hotelbeds.com',
      requestTimeoutMs: 5_000,
      maxRetries: 0,
    });

    await client.listHotels({ pageSize: 10 });
    expect(seen.length).toBe(1);
    expect(seen[0]!.headers['Api-key']).toBe('k');
    expect(seen[0]!.headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]!.headers['Accept']).toBe('application/json');
  });

  it('retries on 503 and surfaces the eventual success', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return makeErrorResponse(503, 'service unavailable');
      }
      return makeJsonResponse({ hotels: [], total: 0 });
    }) as typeof fetch;

    const client = createLiveHotelbedsClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://api.test.hotelbeds.com',
      requestTimeoutMs: 5_000,
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });

    const result = await client.listHotels({ pageSize: 10 });
    expect(calls).toBe(3);
    expect(result.parsed.hotels).toEqual([]);
  });

  it('does not retry on 401 and throws HotelbedsHttpError', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return makeErrorResponse(401, 'invalid signature');
    }) as typeof fetch;

    const client = createLiveHotelbedsClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://api.test.hotelbeds.com',
      requestTimeoutMs: 5_000,
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });

    await expect(client.listHotels({ pageSize: 10 })).rejects.toBeInstanceOf(
      HotelbedsHttpError,
    );
    expect(calls).toBe(1);
  });

  it('normalizes availability response shape (hotels.hotels → hotels)', async () => {
    globalThis.fetch = vi.fn(async () =>
      makeJsonResponse({
        hotels: {
          hotels: [
            {
              code: 1000073,
              currency: 'EUR',
              rooms: [
                {
                  code: 'DBL.ST',
                  rates: [
                    {
                      rateKey: 'rk',
                      rateClass: 'NRF',
                      rateType: 'BOOKABLE',
                      net: '120.50',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ) as typeof fetch;

    const client = createLiveHotelbedsClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://api.test.hotelbeds.com',
      requestTimeoutMs: 5_000,
      maxRetries: 0,
    });

    const result = await client.checkAvailability({
      checkIn: '2026-06-01',
      checkOut: '2026-06-03',
      occupancies: [{ adults: 2, children: 0, childAges: [] }],
      supplierHotelCodes: ['1000073'],
    });

    expect(result.parsed.hotels.length).toBe(1);
    expect(result.parsed.hotels[0]!.code).toBe('1000073');
  });
});

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeErrorResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}
