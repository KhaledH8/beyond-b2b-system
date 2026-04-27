/**
 * Thin HTTP client around Stripe's `POST /v1/fx_quotes` endpoint.
 *
 * Why bare `fetch` (not the official SDK):
 *   - We use exactly one endpoint with one shape; the SDK would pull
 *     in tens of MB and a code-generated client we never call.
 *   - Mirrors the OxrClient pattern already established in this module
 *     (`oxr-client.ts`). Tests stub `globalThis.fetch` once and we are
 *     done.
 *
 * Direction convention (load-bearing — see ADR-024 C5):
 *   For PaymentIntent integration in C5c, Stripe requires the quote
 *   to be created with `from_currency = customer/charge currency` and
 *   `to_currency = platform settlement (= source) currency`. The
 *   returned `exchange_rate` then has the semantics
 *
 *       1 charge = exchange_rate × source
 *
 *   which is the **inverse** of our `booking_fx_lock.rate` column
 *   (which is "1 source = N charge"). The resolver inverts before
 *   storage; this client returns the raw Stripe semantics so the
 *   inversion is visible at one site, not hidden inside the wire layer.
 *
 * Stripe API version: 2025-07-30.preview.
 *   FX Quotes is currently in preview; the version pin is explicit so
 *   a Stripe-side default change does not silently shift our wire
 *   format. Updating it is a deliberate config edit.
 *
 * Auth: HTTP Basic with the secret key as username and an empty
 * password. This is Stripe's standard. We never log the key.
 */

import { Buffer } from 'node:buffer';

export type StripeFxLockDuration = 'none' | 'five_minutes' | 'hour' | 'day';

export interface StripeFxQuoteConfig {
  readonly secretKey: string;
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly lockDuration: StripeFxLockDuration;
  readonly requestTimeoutMs: number;
}

export function loadStripeFxQuoteConfig(): StripeFxQuoteConfig {
  return {
    secretKey: process.env['STRIPE_SECRET_KEY'] ?? '',
    baseUrl: process.env['STRIPE_BASE_URL'] ?? 'https://api.stripe.com',
    apiVersion:
      process.env['STRIPE_API_VERSION'] ?? '2025-07-30.preview',
    lockDuration: parseLockDuration(
      process.env['STRIPE_FX_LOCK_DURATION'],
      'hour',
    ),
    requestTimeoutMs: parsePositiveInt(
      process.env['STRIPE_REQUEST_TIMEOUT_MS'],
      5_000,
    ),
  };
}

function parseLockDuration(
  raw: string | undefined,
  fallback: StripeFxLockDuration,
): StripeFxLockDuration {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'none' || raw === 'five_minutes' || raw === 'hour' || raw === 'day') {
    return raw;
  }
  throw new Error(
    `Invalid STRIPE_FX_LOCK_DURATION="${raw}". Expected none|five_minutes|hour|day.`,
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid Stripe env value "${raw}": expected positive integer`,
    );
  }
  return n;
}

/**
 * Subset of Stripe's FX Quote response we depend on. Extra fields are
 * tolerated.
 */
export interface StripeFxQuoteRawResponse {
  readonly id: string;
  readonly object: string;
  readonly lock_status: string;
  readonly lock_expires_at: number;
  readonly to_currency: string;
  readonly rates: Record<
    string,
    { readonly exchange_rate: number }
  >;
}

/**
 * Normalised projection of one currency-pair quote — exactly one row
 * out of `rates[*]` plus the top-level identifiers. The resolver
 * consumes this shape; the booking-saga integration in C5c does not
 * see the raw Stripe wire format.
 */
export interface StripeFxQuoteResponse {
  readonly id: string;
  /** ISO 8601 UTC. Converted from Stripe's float unix-seconds. */
  readonly lockExpiresAt: string;
  readonly lockStatus: string;
  /** Echo of the request input, uppercased. */
  readonly fromCurrency: string;
  readonly toCurrency: string;
  /**
   * Raw Stripe rate as an 8-decimal string. Semantics:
   *   1 fromCurrency = exchangeRate × toCurrency.
   * The resolver inverts to our `booking_fx_lock.rate` direction.
   */
  readonly exchangeRate: string;
}

export class StripeFxQuoteClient {
  constructor(private readonly cfg: StripeFxQuoteConfig) {}

  async fetchQuote(input: {
    readonly fromCurrency: string;
    readonly toCurrency: string;
  }): Promise<StripeFxQuoteResponse> {
    if (!this.cfg.secretKey) {
      throw new Error(
        'STRIPE_SECRET_KEY env var must be set to fetch Stripe FX quotes',
      );
    }
    const fromLower = input.fromCurrency.toLowerCase();
    const toLower = input.toCurrency.toLowerCase();

    const body = new URLSearchParams();
    body.set('to_currency', toLower);
    body.append('from_currencies[]', fromLower);
    body.set('lock_duration', this.cfg.lockDuration);

    const auth = Buffer.from(`${this.cfg.secretKey}:`).toString('base64');
    const response = await fetch(`${this.cfg.baseUrl}/v1/fx_quotes`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Stripe-Version': this.cfg.apiVersion,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Stripe FX Quote failed: ${response.status} ${response.statusText}`,
      );
    }

    const raw = (await response.json()) as StripeFxQuoteRawResponse;
    return parseStripeQuoteResponse(raw, input.fromCurrency);
  }
}

/**
 * Pure parser. Extracted so the wire-shape → internal-shape mapping
 * can be unit-tested without a network mock.
 *
 * Stripe's `lock_expires_at` is a fractional unix timestamp (e.g.
 * 1731502406.5579598). We multiply by 1000 then drop the fractional
 * milliseconds via `Math.floor` before constructing the Date — the
 * fractional second is below our resolution and rounding it forward
 * could push the lock past its real expiry.
 */
export function parseStripeQuoteResponse(
  raw: StripeFxQuoteRawResponse,
  fromCurrency: string,
): StripeFxQuoteResponse {
  const fromKey = fromCurrency.toLowerCase();
  const rateEntry = raw.rates[fromKey];
  if (!rateEntry) {
    throw new Error(
      `Stripe FX Quote response missing rate for from_currency=${fromKey}`,
    );
  }
  const lockExpiresMs = Math.floor(raw.lock_expires_at * 1000);
  return {
    id: raw.id,
    lockExpiresAt: new Date(lockExpiresMs).toISOString(),
    lockStatus: raw.lock_status,
    fromCurrency: fromCurrency.toUpperCase(),
    toCurrency: raw.to_currency.toUpperCase(),
    exchangeRate: rateEntry.exchange_rate.toFixed(8),
  };
}
