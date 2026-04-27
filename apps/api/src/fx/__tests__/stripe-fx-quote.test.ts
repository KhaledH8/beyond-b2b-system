import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StripeFxQuoteClient,
  parseStripeQuoteResponse,
  type StripeFxQuoteRawResponse,
} from '../stripe-fx-quote.client';

/**
 * Pure unit tests. The HTTP layer is exercised via vi.stubGlobal on
 * `fetch`, mirroring the OXR / ECB sync test pattern. No DB, no real
 * network. parseStripeQuoteResponse is also tested in isolation.
 */

const STRIPE_LATEST_PREFIX = 'https://api.stripe.com/v1/fx_quotes';

const RAW_OK: StripeFxQuoteRawResponse = {
  id: 'fxq_1QKf8UET9NELqCotgW6CNTnm',
  object: 'fx_quote',
  lock_status: 'active',
  lock_expires_at: 1731502406.5579598, // 2024-11-13T12:53:26.557Z
  to_currency: 'usd',
  rates: {
    gbp: { exchange_rate: 1.282 },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStripeQuoteResponse', () => {
  it('extracts the requested from-currency rate and uppercases the codes', () => {
    const out = parseStripeQuoteResponse(RAW_OK, 'GBP');
    expect(out.id).toBe('fxq_1QKf8UET9NELqCotgW6CNTnm');
    expect(out.lockStatus).toBe('active');
    expect(out.fromCurrency).toBe('GBP');
    expect(out.toCurrency).toBe('USD');
    expect(out.exchangeRate).toBe('1.28200000');
  });

  it('floors fractional unix-seconds before constructing the ISO timestamp', () => {
    const out = parseStripeQuoteResponse(RAW_OK, 'gbp');
    // Math.floor(1731502406.5579598 * 1000) = 1731502406557
    expect(out.lockExpiresAt).toBe('2024-11-13T12:53:26.557Z');
  });

  it('throws when the from-currency is not present in the rates dict', () => {
    expect(() => parseStripeQuoteResponse(RAW_OK, 'EUR')).toThrow(
      /missing rate for from_currency=eur/,
    );
  });
});

describe('StripeFxQuoteClient.fetchQuote', () => {
  it('throws when STRIPE_SECRET_KEY is empty', async () => {
    const client = new StripeFxQuoteClient({
      secretKey: '',
      baseUrl: 'https://api.stripe.com',
      apiVersion: '2025-07-30.preview',
      lockDuration: 'hour',
      requestTimeoutMs: 5000,
    });
    await expect(
      client.fetchQuote({ fromCurrency: 'GBP', toCurrency: 'USD' }),
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });

  it('POSTs to /v1/fx_quotes with form body, basic auth, and api version', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(STRIPE_LATEST_PREFIX)) {
          calls.push({ url, init: init ?? {} });
          return new Response(JSON.stringify(RAW_OK), { status: 200 });
        }
        return realFetch(input, init);
      },
    );

    const client = new StripeFxQuoteClient({
      secretKey: 'sk_test_abc',
      baseUrl: 'https://api.stripe.com',
      apiVersion: '2025-07-30.preview',
      lockDuration: 'hour',
      requestTimeoutMs: 5000,
    });
    const result = await client.fetchQuote({
      fromCurrency: 'GBP',
      toCurrency: 'USD',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/fx_quotes');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Stripe-Version']).toBe('2025-07-30.preview');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // Basic auth: base64('sk_test_abc:') = 'c2tfdGVzdF9hYmM6'
    expect(headers['Authorization']).toBe('Basic c2tfdGVzdF9hYmM6');

    const body = (calls[0]!.init.body as string) ?? '';
    expect(body).toContain('to_currency=usd');
    expect(body).toContain('from_currencies%5B%5D=gbp'); // [] URL-encoded
    expect(body).toContain('lock_duration=hour');

    expect(result.id).toBe(RAW_OK.id);
    expect(result.exchangeRate).toBe('1.28200000');
  });

  it('throws on non-2xx HTTP responses', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(STRIPE_LATEST_PREFIX)) {
          return new Response('rate limited', { status: 429 });
        }
        return realFetch(input, init);
      },
    );
    const client = new StripeFxQuoteClient({
      secretKey: 'sk_test_x',
      baseUrl: 'https://api.stripe.com',
      apiVersion: '2025-07-30.preview',
      lockDuration: 'hour',
      requestTimeoutMs: 5000,
    });
    await expect(
      client.fetchQuote({ fromCurrency: 'GBP', toCurrency: 'USD' }),
    ).rejects.toThrow(/Stripe FX Quote failed: 429/);
  });
});
